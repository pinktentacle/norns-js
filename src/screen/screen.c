// E2-01 — norns' screen, in wasm.
//
// This is a transcription of `third_party/norns/matron/src/hardware/screen.cc`
// with the hardware removed, kept function-for-function and call-for-call so
// it can be diffed against upstream by eye. Where it departs, the comment says
// so and why. Nothing here is "improved": E0-17 bounded our fidelity by
// showing that the same cairo calls in the same order produce the same bytes,
// and that argument only holds while the calls stay the same.
//
// What is removed, and nothing else:
//
//   * `ssd1322_*`. There is no panel. `brightness`, `contrast`, `gamma` and
//     `invert` are stored and handed to JS, which applies them when it puts
//     the buffer on a canvas (E2-03). Upstream sends them to the display
//     controller; the VALUES are identical, only the consumer differs.
//   * `screen_results_*`. Upstream returns text extents through a queue
//     because matron's draw thread is not the Lua thread. Here JS calls
//     straight in, so extents are written to out-parameters.
//   * `cr_primary` / contexts / surfaces for `screen.draw_to`. That is the
//     image-object half of §4.3 and belongs with the rest of E2-01; the hooks
//     are here, the implementation is not.
//
// One upstream oddity is reproduced deliberately: `screen_init` sets
// `CAIRO_ANTIALIAS_SUBPIXEL` and `init_font_faces()` then overwrites it with
// `CAIRO_ANTIALIAS_GRAY`. GRAY wins. Keeping both calls in order means our
// output tracks upstream if they ever reorder them. See E0-17d, and
// research/upstream-reports.md #6 for why reviving the dead line would be
// worse than deleting it.

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <cairo.h>
#include <cairo-ft.h>
#include <ft2build.h>
#include FT_FREETYPE_H

#include <emscripten.h>

// The font list is GENERATED from norns' own source by
// tools/extract-fonts.mjs, because `screen.font_face(i)` indexes it and a
// hand-typed copy got three entries wrong on the first attempt: the unscii
// fonts are .pcf not .bdf, bmp/unscii-8.pcf is easy to drop, and the last two
// entries are Particle.ttf and a SECOND norns.ttf.
#include "fonts.h"
#define NUM_FONTS NORNS_NUM_FONTS
#define FONT_FILES NORNS_FONT_FILES

#define SCREEN_W 128
#define SCREEN_H 64
#define NUM_OPS 29

static cairo_surface_t *surface;
static cairo_t *cr;
static cairo_t *cr_primary;

static FT_Library freetype;
static FT_Face face[NUM_FONTS];
static cairo_font_face_t *ct[NUM_FONTS];
// FreeType keeps the pointer a memory face was built from, so we own that
// buffer for the life of the face. See screen_install_font.
static unsigned char *font_blob[NUM_FONTS];
static int num_fonts_loaded;

static bool surface_may_have_color = false;

// Panel state. Upstream pushes these into the SSD1322; we keep them for JS.
static int panel_brightness = 15;
static int panel_contrast = 127;
static double panel_gamma = 1.0;
static int panel_inverted = 0;

// screen.cc:33. Sixteen levels, evenly spaced, 0 to 1. Not a gamma ramp:
// E0-17 measured `screen_level(z)` landing on panel nibble z exactly.
static const float c[16] = {0,
                            0.066666666666667,
                            0.13333333333333,
                            0.2,
                            0.26666666666667,
                            0.33333333333333,
                            0.4,
                            0.46666666666667,
                            0.53333333333333,
                            0.6,
                            0.66666666666667,
                            0.73333333333333,
                            0.8,
                            0.86666666666667,
                            0.93333333333333,
                            1};

// screen.cc:37. The order IS the API: `screen.blend_mode(i)` is an index.
static const cairo_operator_t ops[NUM_OPS] = {
    CAIRO_OPERATOR_OVER,       CAIRO_OPERATOR_XOR,        CAIRO_OPERATOR_ADD,
    CAIRO_OPERATOR_MULTIPLY,   CAIRO_OPERATOR_SCREEN,     CAIRO_OPERATOR_OVERLAY,
    CAIRO_OPERATOR_DARKEN,     CAIRO_OPERATOR_LIGHTEN,    CAIRO_OPERATOR_COLOR_DODGE,
    CAIRO_OPERATOR_COLOR_BURN, CAIRO_OPERATOR_HARD_LIGHT, CAIRO_OPERATOR_SOFT_LIGHT,
    CAIRO_OPERATOR_DIFFERENCE, CAIRO_OPERATOR_EXCLUSION,  CAIRO_OPERATOR_HSL_HUE,
    CAIRO_OPERATOR_HSL_SATURATION, CAIRO_OPERATOR_HSL_COLOR, CAIRO_OPERATOR_HSL_LUMINOSITY,
    CAIRO_OPERATOR_CLEAR,      CAIRO_OPERATOR_SOURCE,     CAIRO_OPERATOR_IN,
    CAIRO_OPERATOR_OUT,        CAIRO_OPERATOR_ATOP,       CAIRO_OPERATOR_DEST,
    CAIRO_OPERATOR_DEST_OVER,  CAIRO_OPERATOR_DEST_IN,    CAIRO_OPERATOR_DEST_OUT,
    CAIRO_OPERATOR_DEST_ATOP,  CAIRO_OPERATOR_SATURATE,
};

static const char *font_dir = "/fonts";

static void init_font_faces(void) {
    if (FT_Init_FreeType(&freetype) != 0) {
        fprintf(stderr, "ERROR (screen) freetype init\n");
        return;
    }
    char path[256];
    num_fonts_loaded = 0;
    for (int i = 0; i < NUM_FONTS; i++) {
        ct[i] = NULL;
        snprintf(path, sizeof(path), "%s/%s", font_dir, FONT_FILES[i]);
        if (FT_New_Face(freetype, path, 0, &face[i]) != 0) {
            // NOT an error here, unlike upstream, because most fonts are
            // deliberately absent from the initial download. See
            // screen_install_font below for why, and for how they arrive.
            continue;
        }
        ct[i] = cairo_ft_font_face_create_for_ft_face(face[i], 0);
        num_fonts_loaded++;
    }

    // screen.cc:257-265, verbatim and in order. This is what overwrites the
    // SUBPIXEL set in screen_init; see the header comment.
    cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    cairo_font_options_t *font_options = cairo_font_options_create();
    cairo_font_options_set_antialias(font_options, CAIRO_ANTIALIAS_GRAY);
    cairo_set_font_options(cr, font_options);
    cairo_font_options_destroy(font_options);

    if (ct[0]) cairo_set_font_face(cr, ct[0]);
    cairo_set_font_size(cr, 8.0);
}

EMSCRIPTEN_KEEPALIVE void screen_init(void) {
    surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, SCREEN_W, SCREEN_H);
    cr = cr_primary = cairo_create(surface);

    cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    cairo_font_options_t *font_options = cairo_font_options_create();
    cairo_font_options_set_antialias(font_options, CAIRO_ANTIALIAS_SUBPIXEL);
    cairo_set_font_options(cr, font_options);
    cairo_font_options_destroy(font_options);

    init_font_faces();

    if (ct[0]) cairo_set_font_face(cr, ct[0]);
    cairo_set_font_size(cr, 8.0);

    // screen.cc:106-108. Upstream calls this "config buffer".
    cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
    cairo_set_source_surface(cr, surface, 0, 0);
}

EMSCRIPTEN_KEEPALIVE int screen_fonts_loaded(void) { return num_fonts_loaded; }
EMSCRIPTEN_KEEPALIVE int screen_font_count(void) { return NUM_FONTS; }

EMSCRIPTEN_KEEPALIVE int screen_font_available(int i) {
    return (i >= 0 && i < NUM_FONTS && ct[i]) ? 1 : 0;
}

/** The file a given index expects, so JS knows what to fetch for it. */
EMSCRIPTEN_KEEPALIVE const char *screen_font_name(int i) {
    if (i < 0 || i >= NUM_FONTS) return "";
    return FONT_FILES[i];
}

/**
 * Install one font at runtime, from bytes JS fetched.
 *
 * norns ships 69 fonts and they are 14 MB on disk, 12 MB of it the `bmp/`
 * bitmap set. Preloading all of them would put more on the wire than the
 * entire rest of the app — E0-38a spent a whole story getting a cold load to
 * 2.1 MB, and this would have more than doubled it for fonts that almost no
 * script selects. Compressed they are still ~3.4 MB.
 *
 * So the build preloads `norns.ttf` and `liquid.ttf` only: index 0 is the
 * default and the only font the menu uses, and the two together are 40 KB.
 * Everything else arrives through here when something asks for it, and
 * `screen_font_face(i)` on a font that has not arrived leaves the current
 * font in place rather than drawing nothing.
 *
 * FreeType does NOT copy the buffer — `FT_New_Memory_Face` keeps the pointer
 * — so the copy is owned for the life of the face, and re-installing an index
 * frees the previous one first.
 */
EMSCRIPTEN_KEEPALIVE int screen_install_font(int i, const unsigned char *data, int len) {
    if (i < 0 || i >= NUM_FONTS || !data || len <= 0) return 0;

    unsigned char *copy = (unsigned char *)malloc((size_t)len);
    if (!copy) return 0;
    memcpy(copy, data, (size_t)len);

    FT_Face f;
    if (FT_New_Memory_Face(freetype, copy, (FT_Long)len, 0, &f) != 0) {
        free(copy);
        return 0;
    }

    if (ct[i]) {
        cairo_font_face_destroy(ct[i]);
        FT_Done_Face(face[i]);
        if (font_blob[i]) free(font_blob[i]);
        num_fonts_loaded--;
    }
    face[i] = f;
    font_blob[i] = copy;
    ct[i] = cairo_ft_font_face_create_for_ft_face(f, 0);
    num_fonts_loaded++;
    return 1;
}

// --- state --------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE void screen_save(void) { cairo_save(cr); }
EMSCRIPTEN_KEEPALIVE void screen_restore(void) { cairo_restore(cr); }

EMSCRIPTEN_KEEPALIVE void screen_font_face(int i) {
    if ((i >= 0) && (i < NUM_FONTS) && ct[i]) {
        cairo_set_font_face(cr, ct[i]);
    }
}

EMSCRIPTEN_KEEPALIVE void screen_font_size(double z) { cairo_set_font_size(cr, z); }

EMSCRIPTEN_KEEPALIVE void screen_aa(int s) {
    cairo_font_options_t *font_options = cairo_font_options_create();
    if (s == 0) {
        cairo_set_antialias(cr, CAIRO_ANTIALIAS_NONE);
        cairo_font_options_set_antialias(font_options, CAIRO_ANTIALIAS_NONE);
    } else {
        cairo_set_antialias(cr, CAIRO_ANTIALIAS_DEFAULT);
        cairo_font_options_set_antialias(font_options, CAIRO_ANTIALIAS_GRAY);
    }
    cairo_set_font_options(cr, font_options);
    cairo_font_options_destroy(font_options);
}

EMSCRIPTEN_KEEPALIVE void screen_level(int z) {
    z = z < 0 ? 0 : (z > 15 ? 15 : z);
    cairo_set_source_rgb(cr, c[z], c[z], c[z]);
}

EMSCRIPTEN_KEEPALIVE void screen_line_width(double w) { cairo_set_line_width(cr, w); }

EMSCRIPTEN_KEEPALIVE void screen_line_cap(const char *style) {
    if (strcmp(style, "round") == 0) {
        cairo_set_line_cap(cr, CAIRO_LINE_CAP_ROUND);
    } else if (strcmp(style, "square") == 0) {
        cairo_set_line_cap(cr, CAIRO_LINE_CAP_SQUARE);
    } else {
        cairo_set_line_cap(cr, CAIRO_LINE_CAP_BUTT);
    }
}

EMSCRIPTEN_KEEPALIVE void screen_line_join(const char *style) {
    if (strcmp(style, "round") == 0) {
        cairo_set_line_join(cr, CAIRO_LINE_JOIN_ROUND);
    } else if (strcmp(style, "bevel") == 0) {
        cairo_set_line_join(cr, CAIRO_LINE_JOIN_BEVEL);
    } else {
        cairo_set_line_join(cr, CAIRO_LINE_JOIN_MITER);
    }
}

EMSCRIPTEN_KEEPALIVE void screen_miter_limit(double limit) { cairo_set_miter_limit(cr, limit); }

EMSCRIPTEN_KEEPALIVE void screen_set_operator(int i) {
    if (i >= 0 && i < NUM_OPS) cairo_set_operator(cr, ops[i]);
}

// --- paths --------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE void screen_move(double x, double y) { cairo_move_to(cr, x, y); }
EMSCRIPTEN_KEEPALIVE void screen_line(double x, double y) { cairo_line_to(cr, x, y); }
EMSCRIPTEN_KEEPALIVE void screen_line_rel(double x, double y) { cairo_rel_line_to(cr, x, y); }
EMSCRIPTEN_KEEPALIVE void screen_move_rel(double x, double y) { cairo_rel_move_to(cr, x, y); }

EMSCRIPTEN_KEEPALIVE void screen_curve(double x1, double y1, double x2, double y2, double x3, double y3) {
    cairo_curve_to(cr, x1, y1, x2, y2, x3, y3);
}
EMSCRIPTEN_KEEPALIVE void screen_curve_rel(double dx1, double dy1, double dx2, double dy2, double dx3,
                                           double dy3) {
    cairo_rel_curve_to(cr, dx1, dy1, dx2, dy2, dx3, dy3);
}
EMSCRIPTEN_KEEPALIVE void screen_arc(double x, double y, double r, double a1, double a2) {
    cairo_arc(cr, x, y, r, a1, a2);
}
EMSCRIPTEN_KEEPALIVE void screen_rect(double x, double y, double w, double h) {
    cairo_rectangle(cr, x, y, w, h);
}
EMSCRIPTEN_KEEPALIVE void screen_close_path(void) { cairo_close_path(cr); }
EMSCRIPTEN_KEEPALIVE void screen_stroke(void) { cairo_stroke(cr); }
EMSCRIPTEN_KEEPALIVE void screen_fill(void) { cairo_fill(cr); }

EMSCRIPTEN_KEEPALIVE void screen_translate(double x, double y) { cairo_translate(cr, x, y); }
EMSCRIPTEN_KEEPALIVE void screen_rotate(double r) { cairo_rotate(cr, r); }

EMSCRIPTEN_KEEPALIVE void screen_current_point(double *x, double *y) {
    cairo_get_current_point(cr, x, y);
}

// --- text ---------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE void screen_text(const char *s) { cairo_show_text(cr, s); }

EMSCRIPTEN_KEEPALIVE void screen_text_right(const char *s) {
    cairo_text_extents_t extents;
    cairo_text_extents(cr, s, &extents);
    cairo_rel_move_to(cr, -extents.width, 0);
    cairo_show_text(cr, s);
}

EMSCRIPTEN_KEEPALIVE void screen_text_center(const char *s) {
    cairo_text_extents_t extents;
    cairo_text_extents(cr, s, &extents);
    cairo_rel_move_to(cr, -extents.width * 0.5, 0);
    cairo_show_text(cr, s);
}

// Upstream MUTATES the caller's string, truncating it in place until it fits,
// then draws it. The mutation is observable: matron hands in a Lua string's
// buffer. Here the caller owns the buffer, so the behaviour is identical as
// long as JS passes a scratch copy — which the binding does.
EMSCRIPTEN_KEEPALIVE void screen_text_trim(char *s, double w) {
    cairo_text_extents_t extents;
    int n = strlen(s);
    do {
        s[n--] = '\0';
        cairo_text_extents(cr, s, &extents);
        if (n <= 0) {
            return;
        }
    } while (extents.width > w);
    cairo_show_text(cr, s);
}

// Upstream posts these through a result queue because its draw thread is not
// the Lua thread. We write them where the caller asks. Only width and height
// are returned to Lua (`weaver.cc:1142` returns 2); the other four are here
// because the cairo struct has them and a future `screen.extents` might.
EMSCRIPTEN_KEEPALIVE void screen_text_extents(const char *s, double *out6) {
    cairo_text_extents_t e;
    cairo_text_extents(cr, s, &e);
    out6[0] = e.width;
    out6[1] = e.height;
    out6[2] = e.x_bearing;
    out6[3] = e.y_bearing;
    out6[4] = e.x_advance;
    out6[5] = e.y_advance;
}

// --- surface ------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE void screen_clear(void) {
    cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
    surface_may_have_color = false;
}

/**
 * The pixel buffer, ARGB32, 128*64*4 bytes.
 *
 * Upstream's `screen_update` ends in `ssd1322_update(surface, …)`, which
 * converts to 4-bit grey and pushes over SPI. Ours flushes and hands the
 * pointer to JS, which does the same conversion on the way to a canvas
 * (E2-07). The flush matters: cairo may be holding drawing in a cache.
 */
EMSCRIPTEN_KEEPALIVE unsigned char *screen_buffer(void) {
    cairo_surface_flush(surface);
    return cairo_image_surface_get_data(surface);
}

EMSCRIPTEN_KEEPALIVE int screen_buffer_stride(void) {
    return cairo_image_surface_get_stride(surface);
}

/**
 * True when something that may carry colour has been drawn.
 *
 * `ssd1322.cc:297-305` reads ONLY the green channel when this is false,
 * justified by "the surface has only been drawn to, so RGB are all equal".
 * Text never sets it; `screen_display_png` and surface display do. JS needs
 * the same flag to pick the same conversion, or a drawn PNG loses its
 * luminance weighting.
 */
EMSCRIPTEN_KEEPALIVE int screen_may_have_color(void) { return surface_may_have_color ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE void screen_peek(int x, int y, int w, int h, unsigned char *out) {
    w = (w <= (SCREEN_W - x)) ? w : (SCREEN_W - x);
    h = (h <= (SCREEN_H - y)) ? h : (SCREEN_H - y);
    cairo_surface_flush(surface);
    uint32_t *data = (uint32_t *)cairo_image_surface_get_data(surface);
    if (!data) return;
    unsigned char *p = out;
    for (int j = y; j < y + h; j++) {
        for (int i = x; i < x + w; i++) {
            *p = data[j * SCREEN_W + i] & 0xF;
            p++;
        }
    }
}

EMSCRIPTEN_KEEPALIVE void screen_poke(int x, int y, int w, int h, unsigned char *buf) {
    w = (w <= (SCREEN_W - x)) ? w : (SCREEN_W - x);
    h = (h <= (SCREEN_H - y)) ? h : (SCREEN_H - y);
    uint32_t *data = (uint32_t *)cairo_image_surface_get_data(surface);
    if (!data) return;
    unsigned char *p = buf;
    uint32_t pixel;
    for (int j = y; j < y + h; j++) {
        for (int i = x; i < x + w; i++) {
            pixel = *p;
            pixel = pixel | (pixel << 4);
            data[j * SCREEN_W + i] = pixel | (pixel << 8) | (pixel << 16) | (pixel << 24);
            p++;
        }
    }
    cairo_surface_mark_dirty(surface);
}

// --- panel state (stored, not sent anywhere) ----------------------------

EMSCRIPTEN_KEEPALIVE void screen_brightness(int v) {
    if (v < 0) v = 0;
    if (v > 15) v = 15;
    // Upstream then does `v += 16` before writing the pre-charge voltage,
    // because below 16 is too dark for the lowest levels on the real panel.
    // That offset is a property of the SSD1322, not of the API, so it is NOT
    // applied here: JS receives 0-15, the range a script set.
    panel_brightness = v;
}

EMSCRIPTEN_KEEPALIVE void screen_contrast(int ct_) {
    if (ct_ < 0) ct_ = 0;
    if (ct_ > 255) ct_ = 255;
    panel_contrast = ct_;
}

EMSCRIPTEN_KEEPALIVE void screen_gamma(double g) {
    if (g < 0.0) g = 0;
    panel_gamma = g;
}

EMSCRIPTEN_KEEPALIVE void screen_invert(int inverted) { panel_inverted = (inverted != 0); }

EMSCRIPTEN_KEEPALIVE int screen_get_brightness(void) { return panel_brightness; }
EMSCRIPTEN_KEEPALIVE int screen_get_contrast(void) { return panel_contrast; }
EMSCRIPTEN_KEEPALIVE double screen_get_gamma(void) { return panel_gamma; }
EMSCRIPTEN_KEEPALIVE int screen_get_inverted(void) { return panel_inverted; }
