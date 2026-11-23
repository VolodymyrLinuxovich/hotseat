// Native benchmark and smoke test for the stats core, built with the system compiler:
//   ./native/build.sh --bench
// Prints one sample result per function and how long each takes, so a change to the C++ can
// be sanity-checked before rebuilding the .wasm.

#include "hotseat_core.h"

#include <chrono>
#include <cstdio>

namespace {

template <typename F>
double time_us(int runs, F fn)
{
    auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < runs; i++)
    {
        fn();
    }
    auto end = std::chrono::steady_clock::now();
    return std::chrono::duration<double, std::micro>(end - start).count() / runs;
}

} // namespace

int main()
{
    const double difficulty[] = {2, 3, 4, 5, 4};
    const double score[] = {4, 4, 5, 5, 3};
    double out[3] = {0, 0, 0};

    hc_ability(difficulty, score, 5, out);
    std::printf("ability: theta %.3f, se %.3f, next %.0f\n", out[0], out[1], out[2]);
    double ability_us = time_us(10000, [&]()
    {
        hc_ability(difficulty, score, 5, out);
    });
    std::printf("  %.2f us per call\n", ability_us);

    hc_bootstrap(score, 5, 5000, 0x9E3779B9u, out);
    std::printf("bootstrap: mean %.2f, 95%% CI %.2f-%.2f\n", out[0], out[1], out[2]);
    double bootstrap_us = time_us(200, [&]()
    {
        hc_bootstrap(score, 5, 5000, 0x9E3779B9u, out);
    });
    std::printf("  %.2f us per call\n", bootstrap_us);

    // Quote "1 2 3" against two answers; the first contains it word for word.
    const int32_t quote[] = {1, 2, 3};
    const int32_t words[] = {9, 9, 1, 2, 3, 8, 1, 7, 2, 3};
    const int32_t offsets[] = {0, 6, 10};
    int32_t span[3] = {0, 0, 0};

    double match = hc_align(quote, 3, words, offsets, 2, span);
    std::printf("align: answer %d, words %d-%d, score %.2f\n", span[0], span[1], span[2], match);
    double align_us = time_us(10000, [&]()
    {
        hc_align(quote, 3, words, offsets, 2, span);
    });
    std::printf("  %.2f us per call\n", align_us);

    return 0;
}
