from __future__ import annotations

from telegram.constants import KeyboardButtonStyle

from chronicle_rift.bot import REPO_URL, _launch_keyboard


def test_launcher_has_colored_deep_link_buttons() -> None:
    kb = _launch_keyboard(mini_app_url="https://x.example", include_mini_app=True)
    buttons = [b for row in kb.inline_keyboard for b in row]
    assert len(buttons) == 14

    web = {b.text: b for b in buttons if b.web_app}
    assert web["▶️  PLAY — RIFT ARENA"].web_app.api_kwargs["start_parameter"] == "play"
    assert web["🏪  Store"].web_app.api_kwargs["start_parameter"] == "shop"
    assert web["🎒  Satchel"].web_app.api_kwargs["start_parameter"] == "satchel"
    assert web["🧙  Heroes"].web_app.api_kwargs["start_parameter"] == "heroes"
    assert web["👤  My Profile"].web_app.api_kwargs["start_parameter"] == "profile"
    assert web["📜  Rules & Regulations"].web_app.api_kwargs["start_parameter"] == "rules"
    assert web["📄  Terms & Conditions"].web_app.api_kwargs["start_parameter"] == "terms"

    # every non-URL launcher button is colored (Telegram cannot tint url buttons)
    styled = [b for b in buttons if b.url is None]
    assert all(b.style is not None for b in styled)
    assert web["▶️  PLAY — RIFT ARENA"].style == KeyboardButtonStyle.SUCCESS
    assert web["🏪  Store"].style == KeyboardButtonStyle.PRIMARY

    def is_feedback(b):
        return b.callback_data is not None and b.callback_data.startswith("feedback:")

    feedback = {b.text: b for b in buttons if is_feedback(b)}
    assert set(feedback) == {"🐛  Bug", "✨  Feature", "💡  Improve"}
    assert all(b.style == KeyboardButtonStyle.DANGER for b in feedback.values())

    # tutorial + owners callbacks are present and colored
    callbacks = {b.callback_data: b for b in buttons if b.callback_data}
    assert callbacks["tutorial"].style == KeyboardButtonStyle.PRIMARY
    assert callbacks["owners"].style == KeyboardButtonStyle.PRIMARY

    # repo + share url buttons
    urls = [b for b in buttons if b.url]
    assert any(b.url == REPO_URL for b in urls)
    assert any(b.url and b.url.startswith("https://t.me/share/url") for b in urls)


def test_launcher_without_minapp_has_no_rows() -> None:
    kb = _launch_keyboard(mini_app_url=None, include_mini_app=False)
    assert len(kb.inline_keyboard) == 0
