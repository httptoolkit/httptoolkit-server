try:
    import importlib
    if not hasattr(importlib, 'reload'):
        raise Exception('wrong importlib')
except:
    import imp
    importlib = imp

def preload_real_module(moduleName):
    # Re-importing the real module at the top level of an override fails after deleting it from
    # sys.modules['httplib'] in Python 2. Some interesting issues there ofc, but doing this 
    # instead works nicely in both Python 2 & 3.
    import sys, os

    override_path = os.path.dirname(os.path.abspath(__file__))
    # print('override path %s' % override_path)
    original_sys_path = list(sys.path)
    # print('sys_path %s' % original_sys_path)
    sys.path = [p for p in sys.path if p != override_path and p != '']
    # print('new sys_path %s' % sys.path)

    del sys.modules[moduleName]
    __import__(moduleName)

    sys.path = original_sys_path