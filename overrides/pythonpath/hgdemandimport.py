from httptoolkit_intercept import preload_real_module

preload_real_module('hgdemandimport')

import hgdemandimport

# Re-export all other public fields
from hgdemandimport import *

# Disable hgdemandimport entirely. This is an optional optimization used by hg, which doesn't play
# nicely with HTTP Toolkit's import hooks, making hg unusable.
hgdemandimport.enable = lambda: None