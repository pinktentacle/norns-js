/* E0-17c instrumentation prototypes.
 *
 * Deliberately uses only const void pointers and ints, so this header needs
 * nothing from pixman
 * and can be included from any of its translation units. See trace-pixman.sh.
 */
#ifndef PIXTRACE_H
#define PIXTRACE_H

void pixtrace_entry (const char *what, int op, int w, int h,
		     int sf, int mf, int df);

void pixtrace_lookup (const void *imp, const void *func, int op,
		      int sf, int mf, int df,
		      unsigned sfl, unsigned mfl, unsigned dfl);

void pixtrace_table (const char *name, const void *fast_paths);

#endif /* PIXTRACE_H */
