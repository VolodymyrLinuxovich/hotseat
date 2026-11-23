// Hotseat stats core: ability estimate, bootstrap interval and quote alignment.
//
// engine/core.js runs this as WebAssembly and falls back to a line-by-line JS port when the
// module can't load. To keep the two bit-for-bit identical, the code sticks to +, -, *, /,
// floor and sqrt (all exactly rounded in both runtimes) and brings its own exp instead of
// trusting two different libm implementations. Build with -ffp-contract=off so the compiler
// never fuses a multiply and an add into one FMA, which JS can't do.

#include "hotseat_core.h"

#include <math.h>
#include <stdlib.h>

namespace {

// The prior: before any answer we assume a middle-of-the-road candidate, give or take a point.
const double PRIOR_MEAN = 3.0;
const double PRIOR_VAR = 1.0;

// Logistic slope per difficulty point. At 1.5 a candidate one point above a question's
// difficulty is expected to clear it about 82% of the time.
const double SLOPE = 1.5;

// We aim the next question where the candidate should succeed about 60% of the time:
// hard enough to learn something, easy enough not to sink them. This is ln(0.6 / 0.4).
const double TARGET_LOGIT = 0.4054651081081644;

const double LN2 = 0.6931471805599453;
const double INV_LN2 = 1.4426950408889634;

const int MAX_NEWTON_STEPS = 50;
const double NEWTON_TOLERANCE = 1e-10;

// Alignment scores. A match is worth more than a gap costs, so one stray filler word in the
// middle of a quote doesn't split it into two short spans.
const int MATCH = 2;
const int MISMATCH = -1;
const int GAP = -1;

const uint32_t DEFAULT_SEED = 0x9E3779B9u;

double clamp(double x, double lo, double hi)
{
    if (x < lo)
    {
        return lo;
    }
    if (x > hi)
    {
        return hi;
    }
    return x;
}

// exp(x) = 2^k * exp(r) with |r| <= ln2 / 2. A fixed 18-term Taylor series on r is accurate
// to the last bit or so, and the JS port runs exactly the same operations in the same order.
double det_exp(double x)
{
    x = clamp(x, -700.0, 700.0);

    double k = floor(x * INV_LN2 + 0.5);
    double r = x - k * LN2;

    double sum = 1.0;
    double term = 1.0;
    for (int i = 1; i <= 18; i++)
    {
        term = term * r / i;
        sum += term;
    }

    // Scaling by powers of two one step at a time is exact, so no ldexp/pow differences.
    int steps = (int)k;
    while (steps > 0)
    {
        sum *= 2.0;
        steps--;
    }
    while (steps < 0)
    {
        sum *= 0.5;
        steps++;
    }
    return sum;
}

double sigmoid(double z)
{
    return 1.0 / (1.0 + det_exp(-z));
}

// Panel scores are 1-5, the model wants a success fraction in 0-1.
double success(double score)
{
    return (clamp(score, 1.0, 5.0) - 1.0) / 4.0;
}

// Fisher information of the posterior at theta: the prior's share plus each answer's p(1 - p).
double information(const double* difficulty, int n, double theta)
{
    double info = 1.0 / PRIOR_VAR;
    for (int i = 0; i < n; i++)
    {
        double p = sigmoid(SLOPE * (theta - clamp(difficulty[i], 1.0, 5.0)));
        info += SLOPE * SLOPE * p * (1.0 - p);
    }
    return info;
}

uint32_t xorshift32(uint32_t x)
{
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return x;
}

// Plain heap sort: no allocation, no exceptions, and nothing that depends on the C++ library.
void sift_down(double* a, int start, int end)
{
    int root = start;
    while (2 * root + 1 < end)
    {
        int child = 2 * root + 1;
        if (child + 1 < end && a[child] < a[child + 1])
        {
            child++;
        }
        if (a[root] >= a[child])
        {
            return;
        }
        double tmp = a[root];
        a[root] = a[child];
        a[child] = tmp;
        root = child;
    }
}

void heap_sort(double* a, int n)
{
    for (int start = n / 2 - 1; start >= 0; start--)
    {
        sift_down(a, start, n);
    }
    for (int end = n - 1; end > 0; end--)
    {
        double tmp = a[0];
        a[0] = a[end];
        a[end] = tmp;
        sift_down(a, 0, end);
    }
}

} // namespace

extern "C" {

uint32_t hc_xorshift(uint32_t state)
{
    return xorshift32(state);
}

int hc_ability(const double* difficulty, const double* score, int n, double* out)
{
    if (n < 0 || out == nullptr)
    {
        return -1;
    }
    if (n > 0 && (difficulty == nullptr || score == nullptr))
    {
        return -1;
    }

    // MAP estimate by Newton's method. The log posterior is concave (logistic likelihood
    // plus a normal prior), so Newton converges from the prior mean in a handful of steps.
    double theta = PRIOR_MEAN;
    int steps = 0;
    while (steps < MAX_NEWTON_STEPS)
    {
        double grad = -(theta - PRIOR_MEAN) / PRIOR_VAR;
        for (int i = 0; i < n; i++)
        {
            double p = sigmoid(SLOPE * (theta - clamp(difficulty[i], 1.0, 5.0)));
            grad += SLOPE * (success(score[i]) - p);
        }

        double step = grad / information(difficulty, n, theta);

        // Damp big jumps so a lopsided first answer can't throw theta far off the scale.
        step = clamp(step, -1.0, 1.0);
        theta += step;
        steps++;

        if (fabs(step) < NEWTON_TOLERANCE)
        {
            break;
        }
    }

    double se = 1.0 / sqrt(information(difficulty, n, theta));
    double reported = clamp(theta, 1.0, 5.0);

    // Predicted success is sigmoid(SLOPE * (theta - d)); solving for 60% gives this d.
    double next = floor(reported - TARGET_LOGIT / SLOPE + 0.5);

    out[0] = reported;
    out[1] = se;
    out[2] = clamp(next, 1.0, 5.0);
    return steps;
}

int hc_bootstrap(const double* score, int n, int resamples, uint32_t seed, double* out)
{
    if (n <= 0 || resamples <= 0 || score == nullptr || out == nullptr)
    {
        return -1;
    }

    double* means = (double*)malloc(sizeof(double) * (size_t)resamples);
    if (means == nullptr)
    {
        return -1;
    }

    double total = 0.0;
    for (int i = 0; i < n; i++)
    {
        total += score[i];
    }

    // xorshift gets stuck at zero, so a zero seed means "use the default".
    uint32_t state = seed == 0 ? DEFAULT_SEED : seed;

    for (int r = 0; r < resamples; r++)
    {
        double sum = 0.0;
        for (int i = 0; i < n; i++)
        {
            state = xorshift32(state);
            sum += score[state % (uint32_t)n];
        }
        means[r] = sum / n;
    }

    heap_sort(means, resamples);

    // Percentile indexes in integer math, so both runtimes pick the same elements.
    int lo = (25 * (resamples - 1)) / 1000;
    int hi = (975 * (resamples - 1) + 999) / 1000;

    out[0] = total / n;
    out[1] = means[lo];
    out[2] = means[hi];

    free(means);
    return 0;
}

double hc_align(const int32_t* quote, int m, const int32_t* words, const int32_t* offsets, int n_answers,
                int32_t* out)
{
    if (out == nullptr)
    {
        return 0.0;
    }
    out[0] = -1;
    out[1] = 0;
    out[2] = 0;
    if (m <= 0 || n_answers <= 0 || quote == nullptr || words == nullptr || offsets == nullptr)
    {
        return 0.0;
    }

    // Smith-Waterman over words. Two rows of scores indexed by quote position, plus the answer
    // word where each running alignment started, so we can report the span without a traceback.
    int32_t* buffer = (int32_t*)malloc(sizeof(int32_t) * 4 * (size_t)(m + 1));
    if (buffer == nullptr)
    {
        return 0.0;
    }
    int32_t* prev = buffer;
    int32_t* cur = prev + (m + 1);
    int32_t* prev_start = cur + (m + 1);
    int32_t* cur_start = prev_start + (m + 1);

    int best = 0;
    for (int k = 0; k < n_answers; k++)
    {
        int begin = offsets[k];
        int len = offsets[k + 1] - begin;

        for (int i = 0; i <= m; i++)
        {
            prev[i] = 0;
            prev_start[i] = 0;
        }

        for (int j = 1; j <= len; j++)
        {
            int32_t word = words[begin + j - 1];
            cur[0] = 0;
            cur_start[0] = j;

            for (int i = 1; i <= m; i++)
            {
                int diag = prev[i - 1] + (quote[i - 1] == word ? MATCH : MISMATCH);
                int up = prev[i] + GAP;
                int left = cur[i - 1] + GAP;

                // Ties go diag, then up, then left, so both runtimes report the same span.
                int value = diag;
                int start = prev[i - 1] == 0 ? j - 1 : prev_start[i - 1];
                if (up > value)
                {
                    value = up;
                    start = prev_start[i];
                }
                if (left > value)
                {
                    value = left;
                    start = cur_start[i - 1];
                }
                if (value <= 0)
                {
                    value = 0;
                    start = j;
                }

                cur[i] = value;
                cur_start[i] = start;

                if (value > best)
                {
                    best = value;
                    out[0] = k;
                    out[1] = start;
                    out[2] = j;
                }
            }

            int32_t* swap = prev;
            prev = cur;
            cur = swap;
            swap = prev_start;
            prev_start = cur_start;
            cur_start = swap;
        }
    }

    free(buffer);
    return (double)best / (double)(MATCH * m);
}

} // extern "C"
