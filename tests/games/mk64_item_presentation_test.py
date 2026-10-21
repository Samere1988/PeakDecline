"""Exercise the production presentation code with a small synthetic matrix pool."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ItemPresentationTests(unittest.TestCase):
    def test_items_keep_identity_when_matrix_allocations_move(self):
        source = (ROOT / 'ports/mk64/src/web_presentation.c').read_text()
        for header in ('ultra64.h', 'defines.h', 'main.h', 'course.h', 'actor_types.h'):
            source = source.replace(f'#include <{header}>', '').replace(f'#include "{header}"', '')
        stub = '''
#include <stdint.h>
#include <assert.h>
#define MTX_KART_POOL_SIZE 32
#define MTX_SHADOW_POOL_SIZE 32
#define MTX_OBJECT_POOL_SIZE 32
#define ACTOR_LIST_SIZE 100
#define RACING 4
typedef struct { unsigned char data[64]; } Mtx;
struct GfxPool { Mtx mtxPersp[4],mtxLookAt[4],mtxKart[32],mtxShadow[32],mtxObject[32]; } pool;
struct GfxPool *gGfxPool=&pool;
int gGlobalTimer,gGamestate=4,gCurrentCourseId,gActiveScreenMode,gRaceState=3;
'''
        checks = '''
static void matrix(float m[4][4], float x) {
    memset(m,0,16*sizeof(float));for(int i=0;i<4;i++)m[i][i]=1;m[3][0]=x;
}
int main(void) {
    float m[4][4];
    gGlobalTimer=10;web_begin_presentation();web_begin_presentation_pass(1);
    web_register_item_matrices(0,7,4,2,4);
    int body=matrix_slot(&pool.mtxObject[3]),shadow=matrix_slot(&pool.mtxObject[2]);
    assert(body!=shadow && body>=WEB_ITEM_BASE);
    matrix(m,100);web_interpolate_matrix(&pool.mtxObject[3],m);
    gGlobalTimer=11;web_begin_presentation();web_begin_presentation_pass(0);
    /* Other visible actors shifted allocation, but this is still shell 7. */
    web_register_item_matrices(0,7,4,8,9);
    assert(matrix_slot(&pool.mtxObject[8])==body);
    assert(matrix_slot(&pool.mtxObject[3])==-1);
    matrix(m,120);web_interpolate_matrix(&pool.mtxObject[8],m);assert(m[3][0]==110);
    /* A different camera, actor, or item state must not borrow its history. */
    web_register_item_matrices(1,7,4,10,11);
    matrix(m,120);web_interpolate_matrix(&pool.mtxObject[10],m);assert(m[3][0]==120);
    web_register_item_matrices(0,8,4,12,13);
    matrix(m,120);web_interpolate_matrix(&pool.mtxObject[12],m);assert(m[3][0]==120);
    web_register_item_matrices(0,7,2,8,9);
    matrix(m,120);web_interpolate_matrix(&pool.mtxObject[8],m);assert(m[3][0]==120);
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'test.c').write_text(stub + source + checks)
            for authority in (False, True):
                with self.subTest(authority=authority):
                    subprocess.run(['python3', str(ROOT / '.tmp/mk64/emsdk/upstream/emscripten/emcc.py'),
                                    str(path / 'test.c'), '-I' + str(ROOT / 'ports/mk64/include'),
                                    *(['-DWEB_AUTHORITY_CANDIDATE'] if authority else []),
                                    '-sENVIRONMENT=node', '-o', str(path / 'test.js')], check=True, capture_output=True)
                    subprocess.run(['node', str(path / 'test.js')], check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
