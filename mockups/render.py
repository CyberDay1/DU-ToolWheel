"""Render the Tool Wheel mockups to 3840x2160 PNGs with headless Chromium.

    python -m pip install playwright && python -m playwright install chromium
    python render.py
"""
import pathlib
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
PAGES = ["A_true_radial", "B_stock_native"]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 3840, "height": 2160}, device_scale_factor=1)
    for name in PAGES:
        page.goto((HERE / (name + ".html")).as_uri())
        page.wait_for_load_state("networkidle")
        page.evaluate("document.fonts.ready")
        page.screenshot(path=str(HERE / (name + ".png")))
        print("wrote", name + ".png")
    browser.close()
