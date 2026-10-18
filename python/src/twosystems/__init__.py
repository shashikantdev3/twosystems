"""twosystems: calibration and checking tools for a cheap, honest watchman for AI coding agents.

Created by Shashikant. https://github.com/shashikantdev3/twosystems
"""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("twosystems")
except PackageNotFoundError:  # running from a source tree without installing
    __version__ = "0.0.0+unknown"

__author__ = "Shashikant"
