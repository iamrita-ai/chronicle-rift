from __future__ import annotations

from telegram.constants import KeyboardButtonStyle

from chronicle_rift.bot import _launch_keyboard


def test_launcher_has_colored_deep_link_buttons() -> None:
    kb = _launch_keyboard(mini_app_url="https://x.example", include_mini_app=True)
    buttons = [b for row in kb.inline_keyboard for b in row]
    assert len(buttons) == 10

    web = {b.text: b for b in buttons if b.web_app}
    assert web["▶️  PLAY — RIFT ARENA"].web_app.api_kwargs["start_parameter"] == "play"
    assert web["🏪  Store"].web_app.api_kwargs["start_parameter"] == "shop"
    assert web["🎒  Satchel"].web_app.api_kwargs["start_parameter"] == "satchel"
    assert web["🧙  Heroes"].web_app.api_kwargs["start_parameter"] == "heroes"
    assert web["👤  My Profile"].web_app.api_kwargs["start_parameter"] == "profile"
    assert web["📜  Rules & Regulations"].web_app.api_kwargs["start_parameter"] == "rules"
    assert web["📄  Terms & Conditions"].web_app.api_kwargs["start_parameter"] == "terms"

    # every launcher button is colored
    assert all(b.style is not None for b in buttons)
    assert web["▶️  PLAY — RIFT ARENA"].style == KeyboardButtonStyle.SUCCESS
    assert web["🏪  Store"].style == KeyboardButtonStyle.PRIMARY

    def is_feedback(b):
        return b.callback_data is not None and b.callback_data.startswith("feedback:")

    feedback = {b.text: b for b in buttons if is_feedback(b)}
    assert set(feedback) == {"🐛  Bug", "✨  Feature", "💡  Improve"}
    assert all(b.style == KeyboardButtonStyle.DANGER for b in feedback.values())


def test_launcher_without_minapp_has_no_rows() -> None:
    kb = _launch_keyboard(mini_app_url=None, include_mini_app=False)
    assert len(kb.inline_keyboard) == 0
