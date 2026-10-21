"""ROM-free checks for the browser texture decoder and native matching keys."""
import importlib.util
from pathlib import Path
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('prepare_hd', ROOT / 'ports/mk64/prepare_hd.py')
hd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hd)


class HDPreparationTests(unittest.TestCase):
    def test_big_endian_color_and_palette_alpha(self):
        palette = bytes.fromhex('f80107c1003f0000')
        self.assertEqual(hd.decode(palette, 'rgba16'), bytes((255,0,0,255,0,255,0,255,0,0,255,255,0,0,0,0)))
        self.assertEqual(hd.decode(bytes((0,2,3)), 'ci8', palette), bytes((255,0,0,255,0,0,255,255,0,0,0,0)))
        self.assertEqual(hd.decode(bytes((0x12,)), 'ci4', palette), bytes((0,255,0,255,0,0,255,255)))
        with self.assertRaises(ValueError):
            hd.decode(bytes((4,)), 'ci8', palette)

    def test_intensity_matches_native_renderer_scaling(self):
        self.assertEqual(hd.decode(bytes((0xf1,)), 'ia4'), bytes((252,252,252,255,0,0,0,255)))
        self.assertEqual(hd.decode(bytes((0xf8,)), 'ia8'), bytes((255,255,255,136)))
        self.assertEqual(hd.decode(bytes((230,5)), 'ia16'), bytes((230,230,230,5)))
        self.assertEqual(hd.decode(bytes((0x0f,)), 'i4'), bytes((0,0,0,0,255,255,255,255)))

    def test_complete_decoded_pixels_and_dimensions_define_identity(self):
        pixels=bytes((i*7)&255 for i in range(8192))
        key=hd.texture_key(pixels,64,32)
        self.assertEqual(key, f'64x32:{zlib.crc32(pixels):08x}:{zlib.adler32(pixels):08x}')
        self.assertNotEqual(key,hd.texture_key(pixels,32,64))
        self.assertNotEqual(key,hd.texture_key(pixels[:-1]+bytes((pixels[-1]^1,)),64,32))


if __name__ == '__main__':
    unittest.main()
