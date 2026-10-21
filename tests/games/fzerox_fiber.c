#include "gdx_fiber.h"
#include <assert.h>
#include <stdio.h>
#ifdef TEST_MAIN_LOOP
#include <emscripten.h>
#endif

static GdxFiber *host, *first, *second;
static int step;

static void second_entry(void *arg) {
    assert(*(int *)arg == 42);
    for (int round = 0; round < 1000; ++round) {
        assert(step == round * 3 + 1);
        ++step;
        gdx_fiber_switch(first);
    }
    assert(0);
}

static void first_entry(void *arg) {
    assert(arg == NULL);
    for (int round = 0; round < 1000; ++round) {
        assert(step == round * 3);
        ++step;
        gdx_fiber_switch(second);
        assert(step == round * 3 + 2);
        ++step;
        gdx_fiber_switch(host);
    }
    assert(0);
}

static int round_number;
static void run_rounds(void) {
    for (int count = 0; count < 10 && round_number < 1000; ++count) {
        gdx_fiber_switch(first);
        if (step != (round_number + 1) * 3) fprintf(stderr, "round=%d step=%d\n", round_number, step);
        assert(step == (++round_number) * 3);
    }
#ifdef TEST_MAIN_LOOP
    if (round_number == 1000) {
        puts("F-Zero browser fibers: main-loop callbacks preserve all 1000 rounds.");
        emscripten_force_exit(0);
    }
#endif
}

int main(void) {
    static int argument = 42;
    host = gdx_fiber_convert_thread();
    assert(host && gdx_fiber_convert_thread() == host);
    first = gdx_fiber_create(first_entry, NULL, 0);
    second = gdx_fiber_create(second_entry, &argument, 65536);
    assert(first && second);
    run_rounds();
#ifdef TEST_MAIN_LOOP
    emscripten_set_main_loop(run_rounds, 1000, 0);
    return 0;
#else
    while (round_number < 1000) run_rounds();
#endif
    puts("F-Zero browser fibers: 1000 rounds preserve stacks, arguments and scheduling order.");
    return 0;
}
