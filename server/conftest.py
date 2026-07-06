# Ensures `import app` works when pytest runs from any directory:
# pytest prepends this conftest's directory (server/) to sys.path.
import pytest


@pytest.fixture(autouse=True)
def _reset_director_state():
    """Process-global state (scene snapshot + conversation memory) must not leak
    between tests, or one test's last_target() would bleed into the next."""
    from app import scene_state, session_context
    from app import active_commands

    session_context.clear()
    scene_state.clear()
    active_commands.clear()
    yield
    session_context.clear()
    scene_state.clear()
    active_commands.clear()
