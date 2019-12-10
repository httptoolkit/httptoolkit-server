try:
    import importlib
    if not hasattr(importlib, 'reload'):
        raise Exception('wrong importlib')
except:
    import imp
    importlib = imp

def preload_real_module(*module_names):
    # Re-importing the real module at the top level of an override fails after deleting it from
    # sys.modules['httplib'] in Python 2. Some interesting issues there ofc, but doing this
    # instead works nicely in both Python 2 & 3.
    import sys, os

    override_path = os.path.dirname(os.path.abspath(__file__))
    original_sys_path = list(sys.path)
    sys.path = [p for p in sys.path if p != override_path and p != '']

    for mod in module_names:
        if mod in sys.modules:
            del sys.modules[mod]
        __import__(mod)

    sys.path = original_sys_path