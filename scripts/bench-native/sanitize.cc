// Memory-safety probe, separate from differential correctness and timing.
#include "../../apps/ingest-adapters/native/html_scan.cc"
#include <cassert>
#include <iostream>
#include <random>

int main() {
    std::mt19937 rng(1928);
    const std::vector<std::string> seeds = {
        "<div class=notes><span>x</div>",
        "<div id=chapters><div class=userstuff>text</div></div>",
        "<!-- x --><script class=notes>x</script><img src='//a/b'>",
        "<style>p{background:url(https://a/b)}</style>",
        "<div class='not&#101;s'>\xc3\xa8\xf0\x9f\x90\x88</div>"
    };
    for (size_t iteration = 0; iteration < 100000; ++iteration) {
        std::string input = seeds[rng() % seeds.size()];
        for (size_t n = rng() % 24; n > 0; --n) {
            size_t pos = rng() % (input.size() + 1);
            if (rng() % 2 || pos == input.size())
                input.insert(pos, 1, static_cast<char>(rng() % 256));
            else
                input.erase(pos, 1);
        }
        for (int mode = 0; mode < 3; ++mode) {
            Result* result = palimora_scan(input.data(), input.size(), mode, 1);
            assert(result && result->status != 2);
            if (result->status == 0) {
                for (size_t n = 0; n < result->count; ++n) {
                    const auto item = result->items[n];
                    assert(item.kind <= 1 && item.start <= item.end && item.end <= input.size());
                }
            }
            palimora_scan_free(result);
        }
    }
    std::cout << "300000 native calls: bounds and sanitizer checks passed\n";
}
