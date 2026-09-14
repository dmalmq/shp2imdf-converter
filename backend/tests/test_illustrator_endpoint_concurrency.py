"""The CPU-bound illustrator endpoints must not run on the event loop.

A `async def` handler runs on the event loop, so synchronous CPU work inside it
blocks every other request for its whole duration. A shape match against a
station-sized Station_pg took the whole API down with it — `/api/health`
included — until the match finished minutes later.

Declared `def`, FastAPI runs them in a threadpool and the server stays
responsive. This is easy to undo by "tidying" a handler back to `async def`, and
the damage does not show up in any functional test, so it is asserted here.
"""

from __future__ import annotations

import inspect

import pytest

from backend.routers import import_router


# Handlers whose bodies are synchronous and CPU-bound.
BLOCKING_HANDLERS = [
    "match_illustrator_shape",
    "match_illustrator_region",
    "snap_illustrator_survey",
    "assign_illustrator_floors",
    "export_illustrator",
]


@pytest.mark.parametrize("name", BLOCKING_HANDLERS)
def test_cpu_bound_handler_is_not_a_coroutine(name: str) -> None:
    handler = getattr(import_router, name)
    assert not inspect.iscoroutinefunction(handler), (
        f"{name} is `async def`, so its CPU-bound body runs on the event loop and "
        "blocks every other request. Declare it `def` (FastAPI will run it in a "
        "threadpool), or wrap the heavy call in `run_in_threadpool`."
    )


@pytest.mark.parametrize("name", BLOCKING_HANDLERS)
def test_blocking_handler_still_exists(name: str) -> None:
    """Guard the list above against a rename silently emptying this file's teeth."""
    assert callable(getattr(import_router, name, None))
