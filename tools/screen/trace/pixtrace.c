/* tools/screen/trace/pixtrace.c -- E0-17c instrumentation helper.
 *
 * Compiled into an INSTRUMENTED copy of pixman (see trace-pixman.sh) so we can
 * record, rather than guess, which pixman entry points and which composite
 * fast paths cairo 1.16.0 reaches for the norns 128x64 ARGB32 surface.
 *
 * Not part of any shipped build. The traced library is byte-for-byte the
 * pixman we ship apart from these printfs, and it is never used to produce a
 * fingerprint transcript.
 */
#ifdef HAVE_CONFIG_H
#include <config.h>
#endif
#include <stdio.h>
#include "pixman-private.h"

static FILE *tf (void)
{
    return stderr;
}

void
pixtrace_entry (const char *what, int op, int w, int h,
		int sf, int mf, int df)
{
    fprintf (tf (), "ENTRY %-26s op=%-3d %3dx%-3d src=%08x mask=%08x dst=%08x\n",
	     what, op, w, h, (unsigned)sf, (unsigned)mf, (unsigned)df);
}

void
pixtrace_lookup (const void *imp, const void *func, int op,
		 int sf, int mf, int df,
		 unsigned sfl, unsigned mfl, unsigned dfl)
{
    const pixman_implementation_t *i = imp;
    fprintf (tf (), "PICK  imp=%-10s func=%p op=%-3d src=%08x mask=%08x dst=%08x "
	     "sflags=%08x mflags=%08x dflags=%08x\n",
	     i && i->imp_name ? i->imp_name : "(null)", func, op,
	     (unsigned)sf, (unsigned)mf, (unsigned)df, sfl, mfl, dfl);
}

void
pixtrace_table (const char *name, const void *fast_paths)
{
    const pixman_fast_path_t *p = fast_paths;
    int n = 0;
    for (; p->op != PIXMAN_OP_NONE; ++p, ++n)
    {
	fprintf (tf (), "TABLE %-10s #%-4d func=%p op=%-3d src=%08x mask=%08x dst=%08x "
		 "sflags=%08x mflags=%08x dflags=%08x\n",
		 name, n, (void *)p->func, p->op,
		 (unsigned)p->src_format, (unsigned)p->mask_format,
		 (unsigned)p->dest_format,
		 p->src_flags, p->mask_flags, p->dest_flags);
    }
}
