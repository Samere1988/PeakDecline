"""Give translated float-to-integer conversions explicit guest rounding modes.

Wasm has no mutable host floating-point rounding environment. The upstream
fenv-based conversion helpers therefore cannot implement the cartridge's CTC1.
Keep FCSR per guest context so native fibers preserve their own conversion mode.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'.tmp/marioparty2-port/include'
OUT.mkdir(parents=True,exist_ok=True)
s='#pragma once\n'+(ROOT/'.tmp/marioparty-recompiler/include/recomp.h').read_text()
s=s.replace('uint32_t status_reg;', 'uint32_t status_reg;\n    uint32_t fcsr;')
s+='''
/* The WebAssembly host always rounds arithmetic to nearest. Guest CTC1 rounding
 * controls conversion explicitly; do not depend on unsupported fesetround(). */
static inline double mp_round_integer(double value, uint32_t mode) {
    switch(mode & 3) {
    case 1: return trunc(value);
    case 2: return ceil(value);
    case 3: return floor(value);
    default: return nearbyint(value);
    }
}
static inline int32_t mp_cvt_word(double value, uint32_t mode) {
    double rounded=mp_round_integer(value,mode);
    return !isfinite(rounded)||rounded < -2147483648.0||rounded >= 2147483648.0
        ? INT32_MIN : (int32_t)rounded;
}
static inline int64_t mp_cvt_long(double value, uint32_t mode) {
    double rounded=mp_round_integer(value,mode);
    return !isfinite(rounded)||rounded < -9223372036854775808.0||rounded >= 9223372036854775808.0
        ? INT64_MIN : (int64_t)rounded;
}
#define get_cop1_cs() ((ctx)->fcsr)
#define set_cop1_cs(value) ((ctx)->fcsr=(uint32_t)(value))
#undef CVT_W_S
#undef CVT_W_D
#undef CVT_L_S
#undef CVT_L_D
#define CVT_W_S(value) mp_cvt_word((value),(ctx)->fcsr)
#define CVT_W_D(value) mp_cvt_word((value),(ctx)->fcsr)
#define CVT_L_S(value) mp_cvt_long((value),(ctx)->fcsr)
#define CVT_L_D(value) mp_cvt_long((value),(ctx)->fcsr)
'''
# Pragma once also protects the appended browser conversion helpers.
(OUT/'recomp.h').write_text(s)
