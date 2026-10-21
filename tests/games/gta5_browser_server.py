"""Loopback-only GTA V browser fixture; never opens production databases."""
from gta5_test import make_app, ROOT

if __name__ == '__main__':
    make_app(ROOT / 'instance').run(host='127.0.0.1', port=8077, threaded=True,
                                  debug=False, use_reloader=False)
