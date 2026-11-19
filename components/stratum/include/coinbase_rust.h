#ifndef COINBASE_RUST_H
#define COINBASE_RUST_H

#include <stddef.h>
#include <stdint.h>

/* Keep this ABI synchronized with rust/src/lib.rs (repr(C)). No ownership crosses
 * the boundary: tx is borrowed and the caller owns the layout and callback state.
 * A callback can precede a validation failure; discard all partial results then. */
typedef struct {
    size_t script_len;
    size_t script_end;
    size_t tag_start;
    uint64_t total;
    uint32_t height;
} coinbase_rs_layout_t;

typedef void (*coinbase_rs_output_fn)(void *context, uint64_t value,
                                      const uint8_t *script, size_t length);

int32_t coinbase_rs_parse(const uint8_t *tx, size_t length, size_t split,
                         size_t extra, uint8_t peercoin, coinbase_rs_layout_t *layout,
                         coinbase_rs_output_fn output, void *context);

#endif
