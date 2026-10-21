/* Browser backend for G-Diffuser's cooperative source-game scheduler.
 * Compile with Emscripten Asyncify. Each game instance owns its WASM module;
 * fibers all execute on its single browser thread in a deterministic order.
 */
#include "gdx_fiber.h"
#include <emscripten/fiber.h>
#include <stdlib.h>

#define ASYNC_STACK_SIZE (128u * 1024u)
struct GdxFiber {
    emscripten_fiber_t context;
    void *stack, *async_stack;
    GdxFiberEntry entry;
    void *arg;
};
static GdxFiber *current;

static GdxFiber *allocate(void) {
    GdxFiber *fiber = calloc(1, sizeof(*fiber));
    if (!fiber) return NULL;
    fiber->async_stack = malloc(ASYNC_STACK_SIZE);
    if (!fiber->async_stack) { free(fiber); return NULL; }
    return fiber;
}

GdxFiber *gdx_fiber_convert_thread(void) {
    if (current) return current;
    GdxFiber *host = allocate();
    if (!host) return NULL;
    emscripten_fiber_init_from_current_context(&host->context, host->async_stack, ASYNC_STACK_SIZE);
    current = host;
    return host;
}

static void enter(void *opaque) {
    GdxFiber *fiber = opaque;
    fiber->entry(fiber->arg);
    /* Matches the native contract: game threads must reschedule, never return. */
    abort();
}

GdxFiber *gdx_fiber_create(GdxFiberEntry entry, void *arg, size_t stack_size) {
    if (!current || !entry) return NULL;
    if (!stack_size) stack_size = 1024u * 1024u;
    GdxFiber *fiber = allocate();
    if (!fiber) return NULL;
    fiber->stack = malloc(stack_size);
    if (!fiber->stack) { free(fiber->async_stack); free(fiber); return NULL; }
    fiber->entry = entry;
    fiber->arg = arg;
    emscripten_fiber_init(&fiber->context, enter, fiber, fiber->stack, stack_size,
                          fiber->async_stack, ASYNC_STACK_SIZE);
    return fiber;
}

void gdx_fiber_switch(GdxFiber *to) {
    if (!current || !to) abort();
    if (current == to) return;
    GdxFiber *from = current;
    current = to;
    emscripten_fiber_swap(&from->context, &to->context);
}

unsigned long gdx_fiber_current_thread_id(void) { return 1; }
