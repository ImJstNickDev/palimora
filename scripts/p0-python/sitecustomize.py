"""Opt-in deterministic Python profiler, only in isolated benchmark processes.

Enable with PYTHONPATH=/app/scripts/p0-python P0_PYTHON_PROFILE=/results/python.
Use a separate diagnostic pass: cProfile overhead is not low enough for baseline.
Profiles are private and may contain source paths, never commit them.
"""
import os
if os.environ.get('P0_PYTHON_PROFILE', '').startswith('/results/'):
    import atexit
    import json
    import resource
    import time
    started = time.monotonic()
    import cProfile
    from multiprocessing.util import Finalize
    profile = cProfile.Profile()
    profile.enable()
    def save():
        profile.disable()
        base = os.environ['P0_PYTHON_PROFILE'] + '-' + str(os.getpid())
        profile.dump_stats(base + '.pstats')
        usage = resource.getrusage(resource.RUSAGE_SELF)
        with open(base + '.json', 'w') as out:
            json.dump(dict(wall_seconds=time.monotonic()-started, user_seconds=usage.ru_utime,
                           system_seconds=usage.ru_stime, max_rss_kib=usage.ru_maxrss,
                           input_blocks=usage.ru_inblock, output_blocks=usage.ru_oublock), out)
    atexit.register(save)
    Finalize(None, save, exitpriority=0)
