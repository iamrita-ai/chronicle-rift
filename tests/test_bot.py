from __future__ import annotations

from telegram.constants import KeyboardButtonStyle

from chronicle_rift.bot import _launch_keyboard, home_caption


def test_launcher_has_colored_deep_link_buttons() -> None:
    kb = _launch_keyboard(
        mini_app_url="https://x.example",
        include_mini_app=True,
        repo_url="https://github.com/iamrita-ai/chronicle-rift",
        share_url="https://t.me/share/url?url=https%3A%2F%2Ft.me%2Fdemo%2Fapp",
    )
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

    # one red feedback button collects every kind of note
    feedback = {b.text: b for b in buttons if b.callback_data == "feedback:start"}
    assert set(feedback) == {"💬  Feedback · Bugs · Ideas"}
    assert feedback["💬  Feedback · Bugs · Ideas"].style == KeyboardButtonStyle.DANGER

    # share + repo — no deploy guide anymore
    urls = {b.text: b.url for b in buttons if b.url}
    assert urls["📢  Share Game"].startswith("https://t.me/share/url?url=")
    assert urls["🐙  GitHub"] == "https://github.com/iamrita-ai/chronicle-rift"
    assert all(b.callback_data != "deploy" for b in buttons)


def test_launcher_without_minapp_has_no_rows() -> None:
    kb = _launch_keyboard(mini_app_url=None, include_mini_app=False)
    assert len(kb.inline_keyboard) == 0


def test_home_caption_keeps_credits_in_the_readme_only() -> None:
    caption = home_caption("1.2.3")
    assert "ChronicleRift v1.2.3" in caption
    # credits live in the README now, not on the bot home screen
    assert "@TechnicalSerena" not in caption
    assert "@XioQuiXan" not in caption
    assert "Owner:" not in caption
    assert "Co-owner:" not in caption
