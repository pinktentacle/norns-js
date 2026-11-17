/*
 * tools/screen/fingerprint.c -- reproducible rendering fingerprint for the
 * norns 128x64 screen.  (backlog E0-17)
 *
 * The point of this file is NOT to draw something pretty. It is to produce a
 * byte-identical, human-diffable transcript of what cairo+FreeType put on the
 * norns framebuffer, so the same transcript can be produced on real norns
 * hardware (or any Debian bullseye box with stock libcairo2 / libfreetype6)
 * and the two diffed with `diff -u`.
 *
 * It therefore mirrors matron/src/hardware/screen.cc EXACTLY, including the
 * things tools/screen/screen-test.c got wrong:
 *
 *   - CAIRO_FORMAT_ARGB32, not RGB24
 *   - clear via CAIRO_OPERATOR_CLEAR + cairo_paint, not a level-0 paint
 *   - cairo_set_font_options() with CAIRO_ANTIALIAS_GRAY, which screen-test.c
 *     never called at all
 *   - screen_aa(0) sets the FONT antialias to NONE as well as the context
 *     antialias; screen-test.c only did the latter, so its "aa off" text was
 *     still grey-antialiased
 *   - the literal 16-entry level table from screen.cc, not l/15.0
 *
 * The reported pixel value is the 4-bit value the SSD1322 panel actually
 * receives. ssd1322.cc builds it as vsriq_n_u8(ARGB.val[1], ARGB.val[1], 4),
 * i.e. it takes the GREEN byte of the ARGB32 surface and keeps its top nibble.
 * Differences below 1/16 of full scale are therefore invisible on hardware, so
 * the fingerprint is taken over nibbles; an 8-bit hash is reported alongside
 * so a sub-threshold difference can still be seen if you want it.
 *
 * Build (wasm):
 *     bash tools/screen/build-cairo.sh
 *     node tools/screen/fingerprint.mjs            > wasm.txt
 *     node tools/screen/fingerprint.mjs --full     > wasm-full.txt
 *
 * Build (native -- ON a norns over ssh, or in a bullseye container):
 *     gcc -O2 -o fingerprint fingerprint.c $(pkg-config --cflags --libs cairo freetype2) -lm
 *     ./fingerprint --font ~/norns/resources/norns.ttf  > norns.txt
 *     diff -u wasm.txt norns.txt
 *
 * Everything printed is deterministic: no time, no pointers, no randomness,
 * no locale-dependent formatting (the C locale is never changed).
 */

#include <cairo.h>
#include <cairo-ft.h>
#include <ft2build.h>
#include FT_FREETYPE_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define W 128
#define H 64

/* ---- verbatim from matron/src/hardware/screen.cc ---------------------- */
static float c[16] = {0, 0.066666666666667, 0.13333333333333, 0.2, 0.26666666666667, 0.33333333333333,
                      0.4, 0.46666666666667, 0.53333333333333, 0.6, 0.66666666666667, 0.73333333333333,
                      0.8, 0.86666666666667, 0.93333333333333, 1};

static cairo_surface_t *surface;
static cairo_t *cr;
static FT_Library ftlib;
static FT_Face ftface;
static cairo_font_face_t *ct0;

static int opt_full = 0;

/* ---- screen.cc equivalents -------------------------------------------- */

static void screen_init(const char *font_path) {
    surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, W, H);
    cr = cairo_create(surface);

    cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    cairo_font_options_t *fo = cairo_font_options_create();
    cairo_font_options_set_antialias(fo, CAIRO_ANTIALIAS_SUBPIXEL);
    cairo_set_font_options(cr, fo);
    cairo_font_options_destroy(fo);

    if (FT_Init_FreeType(&ftlib)) {
        fprintf(stderr, "FATAL freetype init\n");
        exit(1);
    }
    if (FT_New_Face(ftlib, font_path, 0, &ftface)) {
        fprintf(stderr, "FATAL could not load font: %s\n", font_path);
        exit(1);
    }
    ct0 = cairo_ft_font_face_create_for_ft_face(ftface, 0);

    /* init_font_faces() tail: THIS is the font antialias that survives, not
       the SUBPIXEL set above -- screen_init calls init_font_faces last and it
       overwrites the options with CAIRO_ANTIALIAS_GRAY. */
    cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    fo = cairo_font_options_create();
    cairo_font_options_set_antialias(fo, CAIRO_ANTIALIAS_GRAY);
    cairo_set_font_options(cr, fo);
    cairo_font_options_destroy(fo);

    cairo_set_font_face(cr, ct0);
    cairo_set_font_size(cr, 8.0);
}

static void screen_clear(void) {
    cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
}

static void screen_level(int z) {
    z = z < 0 ? 0 : (z > 15 ? 15 : z);
    cairo_set_source_rgb(cr, c[z], c[z], c[z]);
}

static void screen_aa(int s) {
    cairo_font_options_t *fo = cairo_font_options_create();
    if (s == 0) {
        cairo_set_antialias(cr, CAIRO_ANTIALIAS_NONE);
        cairo_font_options_set_antialias(fo, CAIRO_ANTIALIAS_NONE);
    } else {
        cairo_set_antialias(cr, CAIRO_ANTIALIAS_DEFAULT);
        cairo_font_options_set_antialias(fo, CAIRO_ANTIALIAS_GRAY);
    }
    cairo_set_font_options(cr, fo);
    cairo_font_options_destroy(fo);
}

/* ---- readback ---------------------------------------------------------- */

/* ssd1322.cc: green byte, top nibble kept. */
static void read_nibbles(uint8_t *out /* W*H */) {
    cairo_surface_flush(surface);
    const unsigned char *data = cairo_image_surface_get_data(surface);
    int stride = cairo_image_surface_get_stride(surface);
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++) {
            uint32_t px = *(const uint32_t *)(data + y * stride + x * 4);
            out[y * W + x] = (uint8_t)(((px >> 8) & 0xff) >> 4);
        }
}

static void read_bytes(uint8_t *out /* W*H */) {
    cairo_surface_flush(surface);
    const unsigned char *data = cairo_image_surface_get_data(surface);
    int stride = cairo_image_surface_get_stride(surface);
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++) {
            uint32_t px = *(const uint32_t *)(data + y * stride + x * 4);
            out[y * W + x] = (uint8_t)((px >> 8) & 0xff);
        }
}

/* FNV-1a 64. Chosen because it is four lines and trivially reimplementable in
   any language, so a reference run does not strictly need this program. */
static uint64_t fnv1a(const uint8_t *p, size_t n) {
    uint64_t h = 0xcbf29ce484222325ULL;
    for (size_t i = 0; i < n; i++) {
        h ^= p[i];
        h *= 0x100000001b3ULL;
    }
    return h;
}

static const char HEX[] = "0123456789abcdef";

static void emit_frame(const char *scene, int aa) {
    static uint8_t nib[W * H];
    static uint8_t byt[W * H];
    read_nibbles(nib);
    read_bytes(byt);

    printf("scene %s aa=%d\n", scene, aa);
    printf("  hash4 %016llx\n", (unsigned long long)fnv1a(nib, W * H));
    printf("  hash8 %016llx\n", (unsigned long long)fnv1a(byt, W * H));

    int hist[16];
    memset(hist, 0, sizeof hist);
    for (int i = 0; i < W * H; i++) hist[nib[i]]++;
    printf("  hist");
    for (int i = 0; i < 16; i++) printf(" %d:%d", i, hist[i]);
    printf("\n");

    /* per-row hash: localises a difference to a scanline without dumping
       8192 characters on every run */
    for (int y = 0; y < H; y++) {
        uint64_t rh = fnv1a(nib + y * W, W);
        printf("  row %02d %08x\n", y, (unsigned)((rh ^ (rh >> 32)) & 0xffffffffu));
    }

    if (opt_full) {
        for (int y = 0; y < H; y++) {
            char line[W + 1];
            for (int x = 0; x < W; x++) line[x] = HEX[nib[y * W + x]];
            line[W] = 0;
            printf("  px %02d %s\n", y, line);
        }
    }
    printf("\n");
}

/* ---- scenes ------------------------------------------------------------ */

/* S1: the 16 levels as 8px bars. Proves the level table maps to panel nibble
   z exactly: c[z]*255 == 17z, and (17z)>>4 == z for z in 0..15. */
static void scene_levels(void) {
    screen_clear();
    for (int z = 0; z < 16; z++) {
        screen_level(z);
        cairo_rectangle(cr, z * 8, 0, 8, H);
        cairo_fill(cr);
    }
}

/* S2: geometry only, no text. Isolates cairo+pixman from FreeType. */
static void scene_geom(void) {
    screen_clear();
    cairo_set_line_width(cr, 1.0);
    cairo_set_line_cap(cr, CAIRO_LINE_CAP_BUTT);
    cairo_set_line_join(cr, CAIRO_LINE_JOIN_MITER);
    cairo_set_miter_limit(cr, 10.0);

    screen_level(15);
    cairo_move_to(cr, 2, 2);
    cairo_line_to(cr, 60, 30);
    cairo_stroke(cr);

    /* a shallow diagonal: the most AA-sensitive primitive there is */
    cairo_move_to(cr, 0.5, 40.5);
    cairo_line_to(cr, 127.5, 47.5);
    cairo_stroke(cr);

    screen_level(10);
    cairo_arc(cr, 95, 16, 12, 0, 2 * 3.14159265358979323846);
    cairo_stroke(cr);

    screen_level(8);
    cairo_rectangle(cr, 5, 36, 40, 10);
    cairo_fill(cr);

    /* fractional rectangle: exercises pixman's partial-coverage path */
    screen_level(12);
    cairo_rectangle(cr, 70.25, 50.5, 20.5, 6.75);
    cairo_fill(cr);

    screen_level(6);
    cairo_set_line_width(cr, 2.0);
    cairo_move_to(cr, 10, 60);
    cairo_curve_to(cr, 25, 40, 45, 62, 60, 52);
    cairo_stroke(cr);
}

/* S3: text at the norns default -- norns.ttf, 8.0px, integer baselines. */
static const char *TEXT_LINES[] = {
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
    "0123456789 .,:;!?-+*/=<>()",
    "norns-js fidelity 8px",
};
#define N_TEXT_LINES 4

static void scene_text(void) {
    screen_clear();
    screen_level(15);
    cairo_set_font_face(cr, ct0);
    cairo_set_font_size(cr, 8.0);
    for (int i = 0; i < N_TEXT_LINES; i++) {
        cairo_move_to(cr, 1, 10 + i * 10);
        cairo_show_text(cr, TEXT_LINES[i]);
    }
}

/* S4: every glyph on its own, so a FreeType difference cannot hide behind a
   neighbouring glyph. Fixed integer origin; 12x12 crop. */
static const char *GLYPH_SET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?-+*/=<>()[]#%&@";

static void emit_glyphs(int aa) {
    printf("glyphs aa=%d font_size=8.0\n", aa);
    cairo_set_font_face(cr, ct0);
    cairo_set_font_size(cr, 8.0);

    static uint8_t nib[W * H];
    uint8_t crop[144];

    for (const char *p = GLYPH_SET; *p; p++) {
        char s[2];
        cairo_text_extents_t ext;
        s[0] = *p;
        s[1] = 0;

        screen_clear();
        screen_level(15);
        cairo_move_to(cr, 2, 10);
        cairo_show_text(cr, s);
        cairo_text_extents(cr, s, &ext);

        read_nibbles(nib);
        for (int y = 0; y < 12; y++)
            for (int x = 0; x < 12; x++) crop[y * 12 + x] = nib[y * W + x];

        printf("  g %3d %c hash %016llx adv %.6f bx %.6f by %.6f w %.6f h %.6f\n",
               (int)(unsigned char)*p, (*p == ' ' ? '_' : *p),
               (unsigned long long)fnv1a(crop, 144),
               ext.x_advance, ext.x_bearing, ext.y_bearing, ext.width, ext.height);

        if (opt_full) {
            for (int y = 0; y < 12; y++) {
                char line[13];
                for (int x = 0; x < 12; x++) line[x] = HEX[crop[y * 12 + x]];
                line[12] = 0;
                printf("    b %02d %s\n", y, line);
            }
        }
    }
    printf("\n");
}

/* ---- hinting / AA sensitivity probe ------------------------------------
 *
 * This is the part that decides whether the FreeType VERSION can matter.
 *
 *   - "aa_px" is the number of pixels whose panel nibble is strictly between
 *     0 and 15. If it is 0 the glyph coverage is binary, so the changes
 *     FreeType made to the smooth (anti-aliased) rasterizer in 2.11.0
 *     ("there might be very subtle differences in rendering", docs/CHANGES)
 *     have nothing to act on.
 *
 *   - hint=def vs hint=none: with CAIRO_HINT_STYLE_NONE cairo sets
 *     FT_LOAD_NO_HINTING, which bypasses the hinter entirely
 *     (src/base/ftobjs.c). If the two hashes are equal, the hinter is a no-op
 *     for that font at that size, so neither the autofitter nor the TrueType
 *     interpreter -- and hence neither one's version -- can change the result.
 *
 * Run over several fonts because norns.ttf has no bytecode (autofitter) while
 * Roboto/Vera do (TrueType interpreter): different code, different risk.
 */
static void probe_one(const char *label, cairo_font_face_t *ff, double size,
                      cairo_antialias_t aa, cairo_hint_style_t hs) {
    cairo_font_options_t *fo = cairo_font_options_create();
    cairo_font_options_set_antialias(fo, aa);
    cairo_font_options_set_hint_style(fo, hs);
    cairo_set_font_options(cr, fo);
    cairo_font_options_destroy(fo);

    screen_clear();
    screen_level(15);
    cairo_set_font_face(cr, ff);
    cairo_set_font_size(cr, size);
    cairo_move_to(cr, 1, 12);
    cairo_show_text(cr, "Hamburgefonstiv 0123");
    cairo_move_to(cr, 1, 12 + size * 2);
    cairo_show_text(cr, "ILWMQjgpq .,:-+#@");

    static uint8_t nib[W * H];
    read_nibbles(nib);
    int partial = 0, ink = 0;
    for (int i = 0; i < W * H; i++) {
        if (nib[i] > 0) ink++;
        if (nib[i] > 0 && nib[i] < 15) partial++;
    }
    cairo_text_extents_t e;
    cairo_text_extents(cr, "Hamburgefonstiv 0123", &e);

    printf("  probe %-18s size %5.1f aa %-4s hint %-4s hash %016llx ink %4d aa_px %4d width %.6f\n",
           label, size,
           aa == CAIRO_ANTIALIAS_NONE ? "none" : "gray",
           hs == CAIRO_HINT_STYLE_NONE ? "none" : "def",
           (unsigned long long)fnv1a(nib, W * H), ink, partial, e.width);
}

/* The probe fonts live beside the one named by --font, so a native run on
   norns (--font ~/norns/resources/norns.ttf) finds them without a second flag
   and without caring about the working directory. */
static void probe_path(char *out, size_t n, const char *font, const char *name) {
    const char *slash = NULL, *p;
    for (p = font; *p; p++)
        if (*p == '/' || *p == '\\') slash = p;
    if (slash) {
        size_t len = (size_t)(slash - font) + 1;
        if (len >= n) len = n - 1;
        memcpy(out, font, len);
        out[len] = 0;
        strncat(out, name, n - strlen(out) - 1);
    } else {
        snprintf(out, n, "%s", name);
    }
}

static void emit_probes(const char *font) {
    static const char *names[] = {"norns.ttf", "liquid.ttf", "Roboto-Regular.ttf", "VeraMono.ttf"};
    static const double sizes[] = {8.0, 16.0};
    char path[1024];
    printf("hint_and_aa_sensitivity\n");
    for (unsigned f = 0; f < sizeof names / sizeof names[0]; f++) {
        FT_Face fc;
        probe_path(path, sizeof path, font, names[f]);
        if (FT_New_Face(ftlib, path, 0, &fc)) {
            printf("  probe %-18s UNAVAILABLE\n", names[f]);
            continue;
        }
        cairo_font_face_t *ff = cairo_ft_font_face_create_for_ft_face(fc, 0);
        for (unsigned s = 0; s < sizeof sizes / sizeof sizes[0]; s++) {
            probe_one(names[f], ff, sizes[s], CAIRO_ANTIALIAS_GRAY, CAIRO_HINT_STYLE_DEFAULT);
            probe_one(names[f], ff, sizes[s], CAIRO_ANTIALIAS_GRAY, CAIRO_HINT_STYLE_NONE);
            probe_one(names[f], ff, sizes[s], CAIRO_ANTIALIAS_NONE, CAIRO_HINT_STYLE_DEFAULT);
        }
        cairo_font_face_destroy(ff);
    }
    /* leave the context in the norns default state */
    screen_aa(1);
    cairo_set_font_face(cr, ct0);
    cairo_set_font_size(cr, 8.0);
    printf("\n");
}

/* ---- metrics ----------------------------------------------------------- */

static void emit_metrics(void) {
    cairo_font_extents_t fe;
    cairo_set_font_face(cr, ct0);
    cairo_set_font_size(cr, 8.0);
    cairo_font_extents(cr, &fe);
    printf("font_extents ascent %.6f descent %.6f height %.6f max_x_adv %.6f max_y_adv %.6f\n",
           fe.ascent, fe.descent, fe.height, fe.max_x_advance, fe.max_y_advance);

    for (int i = 0; i < N_TEXT_LINES; i++) {
        cairo_text_extents_t e;
        cairo_text_extents(cr, TEXT_LINES[i], &e);
        printf("text_extents %d bx %.6f by %.6f w %.6f h %.6f xa %.6f ya %.6f\n",
               i, e.x_bearing, e.y_bearing, e.width, e.height, e.x_advance, e.y_advance);
    }

    /* FT face facts that decide WHICH hinter runs. maxSizeOfInstructions is
       not public API, so report what is: a face with no bytecode falls through
       to the autofitter (src/base/ftobjs.c, FT_Load_Glyph). */
    printf("ft_face num_glyphs %ld upem %d face_flags 0x%08lx\n",
           (long)ftface->num_glyphs, (int)ftface->units_per_EM,
           (unsigned long)ftface->face_flags);
    if (ftface->size) {
        FT_Size_Metrics *m = &ftface->size->metrics;
        printf("ft_size x_ppem %u y_ppem %u x_scale %ld y_scale %ld ascender %ld descender %ld height %ld\n",
               (unsigned)m->x_ppem, (unsigned)m->y_ppem, (long)m->x_scale, (long)m->y_scale,
               (long)m->ascender, (long)m->descender, (long)m->height);
    }
    printf("\n");
}

/* ---- main -------------------------------------------------------------- */

int main(int argc, char **argv) {
    const char *font = "norns.ttf";
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--full")) {
            opt_full = 1;
        } else if (!strcmp(argv[i], "--font") && i + 1 < argc) {
            font = argv[++i];
        } else {
            fprintf(stderr, "usage: %s [--font PATH] [--full]\n", argv[0]);
            return 2;
        }
    }

    screen_init(font);

    FT_Int fa, fb, fc;
    FT_Library_Version(ftlib, &fa, &fb, &fc);

    /* NB: CAIRO_VERSION_STRING is deliberately poisoned when building against
       cairo's internal headers (cairoint.h), so only the runtime accessor is
       safe here. It is the number that matters anyway. */
    printf("# norns screen fingerprint v1\n");
    printf("cairo_runtime %s\n", cairo_version_string());
    printf("freetype_build %d.%d.%d\n", FREETYPE_MAJOR, FREETYPE_MINOR, FREETYPE_PATCH);
    printf("freetype_runtime %d.%d.%d\n", (int)fa, (int)fb, (int)fc);
    printf("surface ARGB32 %dx%d stride %d\n", W, H, cairo_image_surface_get_stride(surface));
    printf("readback green_top_nibble (ssd1322.cc)\n");
    printf("font %s\n", font);
    printf("\n");

    emit_metrics();
    emit_probes(font);

    for (int aa = 1; aa >= 0; aa--) {
        screen_aa(aa);
        scene_levels();
        emit_frame("levels", aa);
        scene_geom();
        emit_frame("geom", aa);
        scene_text();
        emit_frame("text", aa);
        emit_glyphs(aa);
    }

    printf("# end\n");
    return 0;
}
