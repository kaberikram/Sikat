"""Direct specialist unit tests."""
from app.agents.asset_animator import AssetAnimator
from app.agents.lighting_tech import LightingTech
from app.agents.vfx_operator import VFXOperator
from app.schema import FxSetting, Intent


def test_lighting_tech_dim():
    packets = LightingTech().build(
        Intent(action="update_lights", ambient_intensity=0.3, key_intensity=0.7)
    )
    assert len(packets) == 1
    assert packets[0].command == "UPDATE_LIGHTS"
    assert packets[0].payload.ambient.intensity == 0.3
    assert packets[0].payload.key.intensity == 0.7


def test_lighting_tech_set_material():
    packets = LightingTech().build(
        Intent(action="set_material", target="CORE_SPHERE", color="#ffd700")
    )
    assert packets[0].command == "SET_MATERIAL"
    assert packets[0].payload.target.name == "CORE_SPHERE"
    assert packets[0].payload.color == "#ffd700"


def test_vfx_operator_normalizes_keys():
    packets = VFXOperator().build(
        Intent(
            action="update_fx",
            section="bloom",
            fx_enabled=True,
            fx_set=[FxSetting(key="strength", value=1.2)],
        )
    )
    assert packets[0].command == "UPDATE_FX"
    assert packets[0].payload.patch.strength == 1.2


def test_asset_animator_spawn():
    packets = AssetAnimator().build(
        Intent(action="spawn", primitive="box", color="#ff3b30", name="HERO")
    )
    assert packets[0].command == "SPAWN_OBJECT"
    assert packets[0].payload.primitive == "box"
    assert packets[0].payload.color == "#ff3b30"
