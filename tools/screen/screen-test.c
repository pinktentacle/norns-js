// SUPERSEDED for fidelity work by tools/screen/fingerprint.c. This file answers
// "does screen_aa work at all" and it does, but it diverges from
// matron/src/hardware/screen.cc in six ways (RGB24 not ARGB32; level-0 paint
// not OPERATOR_CLEAR; never calls cairo_set_font_options; screen_aa(0) does not
// switch the FONT antialias to NONE, so its "aa off" text is still grey-
// antialiased; l/15.0 not the c[16] table; reads blue, while ssd1322.cc reads
// green). Enumerated in research/screen-fidelity.md §4. Do not use this file to
// judge pixel fidelity.
//
// P0 spike — risk 3b: does prebuilt cairo+pixman+freetype actually work in WASM,
// and does it give us the one thing Canvas2D cannot — screen_aa?
//
// Mirrors matron/src/hardware/screen.cc: a 128x64 image surface, FreeType font
// faces bound via cairo_ft_font_face_create_for_ft_face, text at 8px.

#include <cairo.h>
#include <cairo-ft.h>
#include <ft2build.h>
#include FT_FREETYPE_H

#include <stdio.h>
#include <string.h>

#define W 128
#define H 64

static cairo_surface_t *surface;
static cairo_t *cr;
static FT_Library ftlib;
static FT_Face ftface;
static cairo_font_face_t *fontface;

// norns levels are 0-15; cairo wants 0.0-1.0
static void set_level(int l) {
    double v = (double)l / 15.0;
    cairo_set_source_rgb(cr, v, v, v);
}

// Print the surface as ASCII so fidelity is visible in the terminal.
static void dump(const char *label) {
    static const char ramp[] = " .:-=+*#%@";
    cairo_surface_flush(surface);
    unsigned char *data = cairo_image_surface_get_data(surface);
    int stride = cairo_image_surface_get_stride(surface);
    printf("\n--- %s ---\n", label);
    for (int y = 0; y < H; y += 2) {        // halve vertically to fit
        putchar('|');
        for (int x = 0; x < W; x++) {
            uint32_t px = *(uint32_t *)(data + y * stride + x * 4);
            int lum = ((px >> 16 & 0xff) + (px >> 8 & 0xff) + (px & 0xff)) / 3;
            putchar(ramp[lum * 9 / 255]);
        }
        printf("|\n");
    }
}

// Count distinct grey levels -- the objective AA measurement.
static int grey_levels(void) {
    cairo_surface_flush(surface);
    unsigned char *data = cairo_image_surface_get_data(surface);
    int stride = cairo_image_surface_get_stride(surface);
    int seen[256] = {0}, n = 0;
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++) {
            uint32_t px = *(uint32_t *)(data + y * stride + x * 4);
            int lum = px & 0xff;
            if (!seen[lum]) { seen[lum] = 1; n++; }
        }
    return n;
}

static void draw_scene(void) {
    cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
    set_level(0);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    // diagonal line -- the classic AA tell
    set_level(15);
    cairo_set_line_width(cr, 1.0);
    cairo_move_to(cr, 2, 2);
    cairo_line_to(cr, 60, 30);
    cairo_stroke(cr);

    // circle
    cairo_arc(cr, 95, 16, 12, 0, 2 * 3.14159265);
    cairo_stroke(cr);

    // filled rect at mid level
    set_level(8);
    cairo_rectangle(cr, 5, 36, 40, 10);
    cairo_fill(cr);

    // text in the norns font at the norns default size
    set_level(15);
    if (fontface) cairo_set_font_face(cr, fontface);
    cairo_set_font_size(cr, 8.0);
    cairo_move_to(cr, 5, 58);
    cairo_show_text(cr, "norns-js 0123");
}

int main(void) {
    printf("cairo version : %s\n", cairo_version_string());
    printf("surface       : %dx%d\n", W, H);

    surface = cairo_image_surface_create(CAIRO_FORMAT_RGB24, W, H);
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        printf("FAIL surface: %s\n", cairo_status_to_string(cairo_surface_status(surface)));
        return 1;
    }
    cr = cairo_create(surface);

    // FreeType, exactly as screen.cc does it
    if (FT_Init_FreeType(&ftlib)) {
        printf("FAIL freetype init\n");
    } else if (FT_New_Face(ftlib, "norns.ttf", 0, &ftface)) {
        printf("WARN could not load norns.ttf (using cairo toy font)\n");
    } else {
        fontface = cairo_ft_font_face_create_for_ft_face(ftface, 0);
        printf("font          : norns.ttf via cairo_ft_font_face_create_for_ft_face OK\n");
    }

    // ---- the decisive test: screen_aa(1) vs screen_aa(0) ----
    cairo_set_antialias(cr, CAIRO_ANTIALIAS_DEFAULT);
    draw_scene();
    int aa_on = grey_levels();
    dump("ANTIALIAS DEFAULT  (Screen.aa(1))");

    cairo_set_antialias(cr, CAIRO_ANTIALIAS_NONE);
    draw_scene();
    int aa_off = grey_levels();
    dump("ANTIALIAS NONE     (Screen.aa(0))");

    printf("\n=== RESULT ===\n");
    printf("distinct grey levels, aa ON  : %d\n", aa_on);
    printf("distinct grey levels, aa OFF : %d\n", aa_off);
    printf("aa actually controllable     : %s\n", (aa_off < aa_on) ? "YES" : "NO");
    printf("  (Canvas2D cannot do this at all)\n");
    return 0;
}
