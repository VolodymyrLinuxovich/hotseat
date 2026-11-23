// Hotseat stats core. Plain C ABI so the same code compiles to WebAssembly for Node and to a
// native binary for the benchmark. Every array is passed as a pointer plus a length, and every
// result is written into a small caller-owned buffer, so nothing crosses the boundary but numbers.

#ifndef HOTSEAT_CORE_H
#define HOTSEAT_CORE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Rasch-style ability estimate on the 1-5 difficulty scale.
// difficulty[i] is the question difficulty (1-5), score[i] the panel score (1-5).
// Writes out[0] = theta, out[1] = standard error, out[2] = recommended next difficulty (1-5).
// Returns the number of Newton steps taken, or -1 on bad input.
int hc_ability(const double* difficulty, const double* score, int n, double* out);

// Mean of the scores with a 95% percentile bootstrap interval.
// Writes out[0] = mean, out[1] = low, out[2] = high. Same seed, same interval.
// Returns 0 on success, -1 on bad input or if the scratch buffer can't be allocated.
int hc_bootstrap(const double* score, int n, int resamples, uint32_t seed, double* out);

// Local word alignment of a quote against several answers.
// quote holds m word ids. words holds every answer's word ids back to back, and answer k covers
// words[offsets[k]] up to words[offsets[k + 1]], so offsets has n_answers + 1 entries.
// Writes out[0] = answer index, out[1] = start word, out[2] = end word (exclusive).
// Returns the alignment score from 0 (nothing shared) to 1 (the quote appears word for word).
double hc_align(const int32_t* quote, int m, const int32_t* words, const int32_t* offsets, int n_answers,
                int32_t* out);

// The xorshift32 step the bootstrap uses, exported so the JS fallback can be checked against it.
uint32_t hc_xorshift(uint32_t state);

#ifdef __cplusplus
}
#endif

#endif
