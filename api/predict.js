import os
import json
import socket
import imaplib
import email as emaillib
from email.header import decode_header
import subprocess
import time
import re
import random
import requests
import logging
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from patchright.sync_api import sync_playwright
from datetime import datetime, timezone


# ─────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────

LOG_DIR = r"C:\temp\torn-logs"
os.makedirs(LOG_DIR, exist_ok=True)
LOG_PATH = os.path.join(LOG_DIR, datetime.now().strftime("torn_%Y-%m-%d_%H-%M-%S.log"))

class _FileFormatter(logging.Formatter):
    def format(self, record):
        return super().format(record).encode("ascii", errors="replace").decode("ascii")

_logger = logging.getLogger("torn")
_logger.setLevel(logging.DEBUG)
_ch = logging.StreamHandler(sys.stdout)
_ch.setFormatter(logging.Formatter("%(message)s"))
_fh = logging.FileHandler(LOG_PATH, encoding="utf-8")
_fh.setFormatter(_FileFormatter("%(asctime)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
_logger.addHandler(_ch)
_logger.addHandler(_fh)

def log(msg: str = ""):
    _logger.info(msg)

def _restart_program():
    """
    Restart this Python process cross-platform.
    - Linux/Mac : os.execv replaces current process in-place (no leftover PID).
    - Windows   : os.execv emulation is broken (OSError ENOMEM); use
                  subprocess.Popen + sys.exit() instead.
    """
    log("   ♻️  Restarting program...")
    if sys.platform == "win32":
        subprocess.Popen([sys.executable] + sys.argv)
        sys.exit(0)
    else:
        os.execv(sys.executable, [sys.executable] + sys.argv)


# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────

BRAVE_PATH    = r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
USER_DATA_DIR = r"C:\temp\brave-automation"
DEBUG_PORT    = 9222
CDP_URL       = f"http://127.0.0.1:{DEBUG_PORT}"

CAPSOLVER_API_KEY  = "CAP-89A8EBE2B06BF9C49B135E4A098A41FE54D0C571358C7D283571903AA49FBDE3"
RECAPTCHA_SITE_KEY = "6LczgsYSAAAAACUIsdTi-gZ9KA_lrAxTEu3NCzt4"
PAGE_URL           = "https://www.torn.com"

# ── Gmail OTP config ─────────────────────────────────────────────────────────
GMAIL_ADDRESS      = "slambergamer@gmail.com"
GMAIL_APP_PASSWORD = "diik kxhb ycko pqic"
OTP_POLL_TIMEOUT   = 60    # seconds to wait for OTP email
OTP_POLL_INTERVAL  = 3     # seconds between inbox checks

# ── Auth cookies — extracted from Brave DevTools → Application → Cookies → torn.com
# Set to None to disable cookie auth and fall back to email/password login.
# Update these when cookies expire (most last until 2026-09-10).
TORN_COOKIES = None  # disabled
_TORN_COOKIES_BACKUP = [
    {"name": "PHPSESSID",     "value": "4ee6338bbb60531d1bcd8d306b9e66d6",                                                                                "domain": "www.torn.com",  "path": "/", "httpOnly": True,  "secure": True},
    {"name": "at",            "value": "59795866ce0cd43f436d9d379e7168663a0d48f52f7fd615d747354a2ea307f2",                                                 "domain": ".torn.com",     "path": "/", "httpOnly": True,  "secure": True},
    {"name": "cf_clearance",  "value": "OQb0kfMgdfooJ5CxTNEjrip1Wz1wkPJ3AdULT_strTI-1773468342-1.2.1.1-xbU6hdDk7Ux9UZ2ltexeYxJnMadK6rOP7y9pc0gAqMEPQoFEpzFgeIk21IAZRB9uhD3qyFfY6vzTAO9xjWMZ4gU5r5NJrKY_O2y151dzbPIK8qa53gwAS.dZXTRry2wWrUtF9O9DuWEmUPxZYCoiQQTM1LiIbqJ1cnXFuUdEvnHX4w.iMZjszYi2_45Fic.qOKNpz9sq9J.ELZ2fCXK5flsXj8BvHUo9ixEhzYuMVilYYiyWayV.DHb9UJ.h86Qo", "domain": ".torn.com",     "path": "/", "httpOnly": False, "secure": True},
    {"name": "logoutHash",    "value": "05276cb473829db5c63b7d96e156ccb8",                                                                                 "domain": ".torn.com",     "path": "/", "httpOnly": False, "secure": False},
    {"name": "isLoggedIn",    "value": "1",                                                                                                                 "domain": "www.torn.com",  "path": "/", "httpOnly": False, "secure": False},
    {"name": "uid",           "value": "1602631",                                                                                                           "domain": "www.torn.com",  "path": "/", "httpOnly": False, "secure": False},
    {"name": "secret",        "value": "69b4fae147bfa0.94761604",                                                                                          "domain": "www.torn.com",  "path": "/", "httpOnly": False, "secure": False},
    {"name": "sso_wiki_token","value": "d8a40a083a4504da2bb85f0c2d30a871957d604f1dbe6f1ae03acfa1d1c39643",                                                  "domain": ".torn.com",     "path": "/", "httpOnly": False, "secure": False},
]

ENERGY_ACTION_MODE = "gym"

# ── Telegram bot ──────────────────────────────────────────────────────────────
TELEGRAM_TOKEN   = "8724242155:AAEm9NS-A7AtC-Rs7tBNDYw7N8XXH9DajeU"
TELEGRAM_CHAT_ID = 550992694
TELEGRAM_OFFSET_FILE = r"C:\temp\torn-logs\tg_offset.txt"

# ── Energy threshold range — adjustable via Telegram /setenergy ──────────────
ENERGY_MIN = 7777
ENERGY_MAX = 7777

# ── Shared bot state ──────────────────────────────────────────────────────────
_bot_paused          = threading.Event()   # set = paused, clear = running
_bot_started         = False               # True once main loop has begun
_flight_held         = threading.Event()   # set = flight blocked (insufficient cash)
_energy_threshold_now = None               # current live threshold, set by main()
_nerve_trigger_now    = None               # current nerve trigger, set by main()
_last_activity_time  = time.time()         # last time browser was active (keep-alive)

# ── Feature toggles — persisted to SETTINGS_FILE, editable via /settings ──────
SETTINGS_FILE = os.path.join(os.path.dirname(__file__), "torn_settings.json")

_settings = {
    "flight":             True,
    "energy":             True,
    "nerve":              True,
    "war_mode":           True,
    "train_points":       99,
    "energy_min":         ENERGY_MIN,
    "energy_max":         ENERGY_MAX,
    "egg_speed_hunt":     False,
    "fly_low_cash":       False,
    "xanax_stacking":     False,   # consume xanax until target energy, energy toggle forced OFF
    "xanax_target":       1000,    # target energy for xanax stacking   # fly even with insufficient cash (toggle via /resumeflight)
    "predict_confidence": 0.5,     # min confidence to trust predict API
    "stock_buffer":       -5,      # safety buffer subtracted from avgStockDuration (negative = subtract)
    "last_cash":          0,       # cached from last travel cycle
    "flight_destination": None,    # current flight destination name
    "flight_eta":         None,    # unix timestamp when we land
}

def load_settings():
    """Load all settings from disk. Falls back to defaults."""
    global _settings, WAR_MODE, ENERGY_MIN, ENERGY_MAX, TRAIN_POINTS, PREDICT_MIN_CONFIDENCE
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
        _settings.update({k: v for k, v in saved.items() if k in _settings})
        WAR_MODE              = _settings["war_mode"]
        ENERGY_MIN            = _settings["energy_min"]
        ENERGY_MAX            = _settings["energy_max"]
        TRAIN_POINTS          = _settings["train_points"]
        PREDICT_MIN_CONFIDENCE = _settings["predict_confidence"]
        log(f"   📂 Settings loaded: {_settings}")
    except FileNotFoundError:
        log("   📂 No settings file — using defaults")
    except Exception as e:
        log(f"   ⚠️ Could not load settings: {e}")

def save_settings():
    """Persist all settings to disk."""
    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(_settings, f, indent=2)
    except Exception as e:
        log(f"   ⚠️ Could not save settings: {e}")

# ── War mode ──────────────────────────────────────────────────────────
# Set True during faction wars — strips all big delays, no page browsing,
# micro jitter only. Set False for normal stealth play.
WAR_MODE = True

TRAIN_POINTS = 99   # how many reps to train per gym session — editable via /settrainpoints

TARGET_RATIO = {"strength": 1, "speed": 1, "defense": 1, "dexterity": 1}

# ─────────────────────────────────────────────
# CRIME CONFIG
# ─────────────────────────────────────────────
#
# CRIME_CATALOGUE — full Crimes 1.0 list with exact UI label text.
# All labels verified from live crimes.php.
#
# SELECTED_CRIMES — the (category, subcategory) pairs you want the bot to run.
# Uncomment any line to enable that crime.
#
# CRIME_SELECTION:
#   "random"     — pick randomly from SELECTED_CRIMES each nerve action
#   "sequential" — rotate through SELECTED_CRIMES in order
# ─────────────────────────────────────────────

CRIME_CATALOGUE = {

    # ── 2 nerve ──────────────────────────────────────────────────────
    "Search for Cash": [
        ("Search the Train Station",    2),
        ("Search Under the Old Bridge", 2),
        ("Search the Bins",             2),
        ("Search the Water Fountain",   2),
        ("Search the Dumpsters",        2),
        ("Search the Movie Theater",    2),
    ],

    # ── 3 nerve ──────────────────────────────────────────────────────
    "Sell Copied Media": [
        ("Rock CDs",        3),
        ("Heavy Metal CDs", 3),
        ("Pop CDs",         3),
        ("Rap CDs",         3),
        ("Reggae CDs",      3),
        ("Horror DVDs",     3),
        ("Action DVDs",     3),
        ("Romance DVDs",    3),
        ("Sci Fi DVDs",     3),
        ("Thriller DVDs",   3),
    ],

    # ── 4 nerve ──────────────────────────────────────────────────────
    "Shoplift": [
        ("Sweet Shop",   4),
        ("Market Stall", 4),
        ("Clothes Shop", 4),
        ("Jewelry Shop", 4),
    ],

    # ── 5 nerve ──────────────────────────────────────────────────────
    "Pickpocket Someone": [
        ("Hobo",        5),
        ("Kid",         5),
        ("Old Woman",   5),
        ("Businessman", 5),
        ("Lawyer",      5),
    ],

    # ── 6 nerve ──────────────────────────────────────────────────────
    "Larceny": [
        ("Apartment",      6),
        ("Detached House", 6),
        ("Mansion",        6),
        ("Cars",           6),
        ("Office",         6),
    ],

    # ── 7 nerve ──────────────────────────────────────────────────────
    "Armed Robberies": [
        ("Swift Robbery",        7),
        ("Thorough Robbery",     7),
        ("Swift Convenience",    7),
        ("Thorough Convenience", 7),
        ("Swift Bank",           7),
        ("Thorough Bank",        7),
        ("Swift Armored Car",    7),
        ("Thorough Armored Car", 7),
    ],

    # ── 8 nerve ──────────────────────────────────────────────────────
    "Transport Drugs": [
        ("Transport Cannabis",     8),
        ("Transport Amphetamines", 8),
        ("Transport Cocaine",      8),
        ("Sell Cannabis",          8),
        ("Sell Pills",             8),
        ("Sell Cocaine",           8),
    ],

    # ── 9 nerve ──────────────────────────────────────────────────────
    "Plant a Computer Virus": [
        ("Simple Virus",      9),
        ("Polymorphic Virus", 9),
        ("Tunneling Virus",   9),
        ("Armored Virus",     9),
        ("Stealth Virus",     9),
    ],

    # ── 10 nerve ─────────────────────────────────────────────────────
    "Assassination": [
        ("Assassinate a Target", 10),
        ("Drive-by Shooting",    10),
        ("Car Bomb",             10),
        ("Mob Boss",             10),
    ],

    # ── 11 nerve ─────────────────────────────────────────────────────
    "Arson": [
        ("Home",                11),
        ("Car Lot",             11),
        ("Office Building",     11),
        ("Apartment Building",  11),
        ("Warehouse",           11),
        ("Motel",               11),
        ("Government Building", 11),
    ],

    # ── 12 nerve ─────────────────────────────────────────────────────
    "Grand Theft Auto": [
        ("Steal a Parked Car",      12),
        ("Hijack a Car",            12),
        ("Steal Car from Showroom", 12),
    ],

    # ── 13 nerve ─────────────────────────────────────────────────────
    "Pawn Shop": [
        ("Side Door", 13),
        ("Rear Door", 13),
    ],

    # ── 14 nerve ─────────────────────────────────────────────────────
    "Counterfeiting": [
        ("Money",         14),
        ("Casino Tokens", 14),
        ("Credit Card",   14),
    ],

    # ── 15 nerve ─────────────────────────────────────────────────────
    "Kidnapping": [
        ("Kid",           15),
        ("Woman",         15),
        ("Undercover Cop", 15),
        ("Mayor",         15),
    ],

    # ── 16 nerve ─────────────────────────────────────────────────────
    "Arms Trafficking": [
        ("Explosives", 16),
        ("Firearms",   16),
    ],

    # ── 17 nerve ─────────────────────────────────────────────────────
    "Bombings": [
        ("Bomb a Factory",             17),
        ("Bomb a Government Building", 17),
    ],

    # ── 18 nerve ─────────────────────────────────────────────────────
    "Hacking": [
        ("Hack into a Bank Mainframe", 18),
        ("Hack the F.B.I Mainframe",   18),
    ],
}

# ── Active crime selection ────────────────────────────────────────────
# Uncomment / comment lines to choose what crimes the bot runs.

SELECTED_CRIMES = [

    # ("Search for Cash",        "Search the Train Station"),
    # ("Search for Cash",        "Search Under the Old Bridge"),
    # ("Search for Cash",        "Search the Bins"),
    # ("Search for Cash",        "Search the Water Fountain"),
    # ("Search for Cash",        "Search the Dumpsters"),
    # ("Search for Cash",        "Search the Movie Theater"),
    # ("Sell Copied Media",      "Rock CDs"),
    # ("Sell Copied Media",      "Heavy Metal CDs"),
    # ("Sell Copied Media",      "Pop CDs"),
    # ("Sell Copied Media",      "Rap CDs"),
    # ("Sell Copied Media",      "Reggae CDs"),
    # ("Sell Copied Media",      "Horror DVDs"),
    # ("Sell Copied Media",      "Action DVDs"),
    # ("Sell Copied Media",      "Romance DVDs"),
    # ("Sell Copied Media",      "Sci Fi DVDs"),
    # ("Sell Copied Media",      "Thriller DVDs"),
    ("Shoplift", "Sweet Shop"),
    # ("Shoplift", "Clothes Shop"),
    # ("Shoplift",               "Market Stall"),
    # ("Shoplift",               "Jewelry Shop"),
    # ("Pickpocket Someone",     "Hobo"),
    # ("Pickpocket Someone",     "Kid"),
    # ("Pickpocket Someone",     "Old Woman"),
    # ("Pickpocket Someone",     "Businessman"),
    # ("Pickpocket Someone",     "Lawyer"),
    # ("Larceny",                "Apartment"),
    # ("Larceny",                "Detached House"),
    # ("Larceny",                "Mansion"),
    # ("Larceny",                "Cars"),
    # ("Larceny",                "Office"),
    # ("Armed Robberies",        "Swift Robbery"),
    # ("Armed Robberies",        "Thorough Robbery"),
    # ("Armed Robberies",        "Swift Convenience"),
    # ("Armed Robberies",        "Thorough Convenience"),
    # ("Armed Robberies",        "Swift Bank"),
    # ("Armed Robberies",        "Thorough Bank"),
    # ("Armed Robberies",        "Swift Armored Car"),
    # ("Armed Robberies",        "Thorough Armored Car"),
    # ("Transport Drugs",        "Transport Cannabis"),
    # ("Transport Drugs",        "Transport Amphetamines"),
    # ("Transport Drugs",        "Transport Cocaine"),
    # ("Transport Drugs",        "Sell Cannabis"),
    # ("Transport Drugs",        "Sell Pills"),
    # ("Transport Drugs",        "Sell Cocaine"),
    # ("Plant a Computer Virus", "Simple Virus"),
    # ("Plant a Computer Virus", "Polymorphic Virus"),
    # ("Plant a Computer Virus", "Tunneling Virus"),
    # ("Plant a Computer Virus", "Armored Virus"),
    # ("Plant a Computer Virus", "Stealth Virus"),
    # ("Assassination",          "Assassinate a Target"),
    # ("Assassination",          "Drive-by Shooting"),
    # ("Assassination",          "Car Bomb"),
    # ("Assassination",          "Mob Boss"),
    # ("Arson",                  "Home"),
    # ("Arson",                  "Car Lot"),
    # ("Arson",                  "Office Building"),
    # ("Arson",                  "Apartment Building"),
    # ("Arson",                  "Warehouse"),
    # ("Arson",                  "Motel"),
    # ("Arson",                  "Government Building"),
    # ("Grand Theft Auto",       "Steal a Parked Car"),
    # ("Grand Theft Auto",       "Hijack a Car"),
    # ("Grand Theft Auto",       "Steal Car from Showroom"),
    # ("Pawn Shop",              "Side Door"),
    # ("Pawn Shop",              "Rear Door"),
    # ("Counterfeiting",         "Money"),
    # ("Counterfeiting",         "Casino Tokens"),
    # ("Counterfeiting",         "Credit Card"),
    # ("Kidnapping",             "Kid"),
    # ("Kidnapping",             "Woman"),
    # ("Kidnapping",             "Undercover Cop"),
    # ("Kidnapping",             "Mayor"),
    # ("Arms Trafficking",       "Explosives"),
    # ("Arms Trafficking",       "Firearms"),
    # ("Bombings",               "Bomb a Factory"),
    # ("Bombings",               "Bomb a Government Building"),
    # ("Hacking",                "Hack into a Bank Mainframe"),
    # ("Hacking",                "Hack the F.B.I Mainframe"),
]

CRIME_SELECTION = "random"   # "random" | "sequential"
_crime_index    = 0

# ─────────────────────────────────────────────
# TRAVEL CONFIG
# ─────────────────────────────────────────────

DROQS_COUNTRY_URL = "https://droqsdb.com/api/public/v1/country/{country}"

# Stock tracker predict API
PREDICT_API_URL = "https://torn-stock-tracker.vercel.app/api/predict"
PREDICT_API_TOKEN = "v3CWFEDg24av"
PREDICT_MIN_CONFIDENCE = 0.5   # below this → fall back to estimatedRestockMinutes logic

# Restock window for normal mode (mins): fly if land within this window of restock
RESTOCK_WINDOW_EARLY = -5   # default: land up to 5min BEFORE restock
RESTOCK_WINDOW_LATE  = 15   # default: land up to 15min AFTER restock
FILLER_BUFFER_MINS   = 15   # cushion between filler return and priority window

# Per-item restock windows — overrides defaults for specific items
# Edit via /setwindow in Telegram. Key = itemName (case sensitive)
# Example: {"Xanax": (-2, 5), "Cherry Blossom": (-5, 15)}
ITEM_RESTOCK_WINDOWS: dict[str, tuple[int, int]] = {}

# Persists user's priority choices across restarts (edited via /priority in Telegram)
PRIORITIES_FILE = r"C:\temp\torn-logs\torn_priorities.json"

FLIGHT_TIMES = {
    "mex": {"name": "Mexico",         "seconds": 1080},   # 18 min
    "cay": {"name": "Cayman Islands", "seconds": 1500},   # 25 min
    "can": {"name": "Canada",         "seconds": 1740},   # 29 min
    "haw": {"name": "Hawaii",         "seconds": 5640},   # 94 min
    "uni": {"name": "UK",             "seconds": 6660},   # 111 min
    "arg": {"name": "Argentina",      "seconds": 7020},   # 117 min
    "swi": {"name": "Switzerland",    "seconds": 7380},   # 123 min
    "jap": {"name": "Japan",          "seconds": 9480},   # 158 min
    "chi": {"name": "China",          "seconds": 10140},  # 169 min
    "uae": {"name": "UAE",            "seconds": 11400},  # 190 min
    "sou": {"name": "South Africa",   "seconds": 12480},  # 208 min
}

# DroqsDB uses full country names -- map to our cc codes
DROQS_COUNTRY_TO_CC = {
    "Mexico":          "mex",
    "Cayman Islands":  "cay",
    "Canada":          "can",
    "Hawaii":          "haw",
    "United Kingdom":  "uni",
    "Argentina":       "arg",
    "Switzerland":     "swi",
    "Japan":           "jap",
    "China":           "chi",
    "UAE":             "uae",
    "South Africa":    "sou",
}

# Full catalogue of selectable priority targets (shown in /priority keyboard)
ALL_POSSIBLE_TARGETS = [
    ("jap", "Xanax"),
    ("jap", "Cherry Blossom"),
    ("sou", "Xanax"),
    ("sou", "Lion Plushie"),
    ("sou", "African Violet"),
    ("can", "Xanax"),
    ("uni", "Xanax"),
    ("cay", "Stingray Plushie"),
    ("cay", "Banana Orchid"),
    ("mex", "Jaguar Plushie"),
    ("mex", "Dahlia"),
    ("can", "Wolverine Plushie"),
    ("can", "Crocus"),
    ("haw", "Orchid"),
    ("uni", "Red Fox Plushie"),
    ("uni", "Nessie Plushie"),
    ("uni", "Heather"),
    ("arg", "Monkey Plushie"),
    ("arg", "Ceibo Flower"),
    ("swi", "Chamois Plushie"),
    ("swi", "Edelweiss"),
    ("chi", "Panda Plushie"),
    ("chi", "Peony"),
    ("uae", "Camel Plushie"),
    ("uae", "Tribulus Omanense"),
]

# ── Smart scheduler config ─────────────────────────────────────────────────
BUY_TIME_SECS = 60

# ── Egg hunt config ────────────────────────────────────────────────────────────
_egg_index      = 0    # current position in EVERY_LINK
_egg_pages_seen = 0    # pages visited this session
_egg_total      = 0    # total eggs found all-time (loaded from file)
_egg_session    = 0    # eggs found this session

EGG_STATS_FILE = os.path.join(os.path.dirname(__file__), "torn_egg_stats.json")


def load_egg_stats():
    """Load egg stats from disk."""
    global _egg_total
    try:
        with open(EGG_STATS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        _egg_total = data.get("total_eggs", 0)
        log(f"   🥚 Egg stats loaded: {_egg_total} total eggs found")
    except FileNotFoundError:
        pass
    except Exception as e:
        log(f"   ⚠️ Could not load egg stats: {e}")


def save_egg_find(page_name: str):
    """Record an egg find to disk and update counters."""
    global _egg_total, _egg_session
    _egg_total   += 1
    _egg_session += 1
    try:
        # Load existing history
        try:
            with open(EGG_STATS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {"total_eggs": 0, "history": []}

        data["total_eggs"] = _egg_total
        data["history"].insert(0, {
            "page":      page_name,
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "index":     _egg_index,
            "session_egg": _egg_session,
        })
        # Keep last 100 entries
        data["history"] = data["history"][:100]

        with open(EGG_STATS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        log(f"   ⚠️ Could not save egg stats: {e}")



EVERY_LINK = [
    "index.php", "city.php", "jobs.php", "gym.php", "properties.php",
    "page.php?sid=education", "crimes.php", "loader.php?sid=missions",
    "newspaper.php", "jailview.php", "hospitalview.php", "casino.php",
    "page.php?sid=hof", "factions.php", "competition.php",
    "page.php?sid=list&type=friends", "page.php?sid=list&type=enemies",
    "page.php?sid=list&type=targets", "messages.php", "page.php?sid=events",
    "page.php?sid=awards", "page.php?sid=points", "rules.php", "staff.php",
    "credits.php", "citystats.php", "committee.php", "bank.php", "donator.php",
    "item.php", "page.php?sid=stocks", "fans.php", "museum.php",
    "loader.php?sid=racing", "church.php", "dump.php", "loan.php",
    "page.php?sid=travel", "amarket.php", "bigalgunshop.php",
    "shops.php?step=bitsnbobs", "shops.php?step=cyberforce",
    "shops.php?step=docks", "shops.php?step=jewelry", "shops.php?step=nikeh",
    "shops.php?step=pawnshop", "shops.php?step=pharmacy", "pmarket.php",
    "shops.php?step=postoffice", "shops.php?step=super", "shops.php?step=candy",
    "shops.php?step=clothes", "shops.php?step=recyclingcenter",
    "shops.php?step=printstore", "page.php?sid=ItemMarket", "estateagents.php",
    "bazaar.php?userId=1", "page.php?sid=bazaar", "calendar.php",
    "token_shop.php", "freebies.php", "bringafriend.php", "comics.php",
    "archives.php", "joblist.php", "newspaper_class.php", "personals.php",
    "profiles.php?XID=1", "newspaper.php#/archive", "bounties.php",
    "usersonline.php", "page.php?sid=log&otherUser=1468764",
    "page.php?sid=ammo", "playerreport.php", "page.php?sid=itemsMods",
    "displaycase.php", "trade.php", "crimes.php?step=criminalrecords",
    "page.php?sid=factionWarfare#/dirty-bombs", "page.php?sid=crimesRecord",
    "index.php?page=fortune", "page.php?sid=bunker", "church.php?step=proposals",
    "messageinc.php", "preferences.php", "messageinc2.php#!p=main",
    "page.php?sid=gallery&XID=1", "personalstats.php?ID=1",
    "properties.php?step=rentalmarket", "properties.php?step=sellingmarket",
    "forums.php", "page.php?sid=slots", "page.php?sid=roulette",
    "page.php?sid=highlow", "page.php?sid=keno", "page.php?sid=craps",
    "page.php?sid=bookie", "page.php?sid=lottery", "page.php?sid=blackjack",
    "page.php?sid=holdem", "page.php?sid=russianRoulette",
    "page.php?sid=spinTheWheel", "page.php?sid=spinTheWheelLastSpins",
    "page.php?sid=slotsStats", "page.php?sid=slotsLastRolls",
    "page.php?sid=rouletteStatistics", "page.php?sid=rouletteLastSpins",
    "page.php?sid=highlowStats", "page.php?sid=highlowLastGames",
    "page.php?sid=kenoStatistics", "page.php?sid=kenoLastGames",
    "page.php?sid=crapsStats", "page.php?sid=crapsLastRolls",
    "page.php?sid=bookie#/stats/", "page.php?sid=lotteryTicketsBought",
    "page.php?sid=lotteryPreviousWinners", "page.php?sid=blackjackStatistics",
    "page.php?sid=blackjackLastGames", "page.php?sid=holdemStats",
    "page.php?sid=russianRouletteStatistics",
    "page.php?sid=russianRouletteLastGames",
    "messageinc2.php#!p=viewall", "bazaar.php#/add", "bazaar.php#/personalize",
    "factions.php?step=your#/tab=crimes", "factions.php?step=your#/tab=rank",
    "page.php?sid=events#onlySaved=true",
    "factions.php?step=your#/tab=controls", "factions.php?step=your#/tab=info",
    "messages.php#/p=ignorelist", "messages.php#/p=outbox",
    "factions.php?step=your#/tab=upgrades", "messages.php#/p=saved",
    "messages.php#/p=compose", "displaycase.php#add", "displaycase.php#manage",
    "factions.php?step=your#/tab=armoury", "bazaar.php#/manage",
    "companies.php", "itemuseparcel.php", "index.php?page=rehab",
    "index.php?page=people", "page.php?sid=UserList", "index.php?page=hunting",
    "donatordone.php", "revive.php", "pc.php",
    "loader.php?sid=attack&user2ID=1", "loader.php?sid=crimes",
    "loader.php?sid=crimes#/searchforcash", "loader.php?sid=crimes#/bootlegging",
    "loader.php?sid=crimes#/graffiti", "loader.php?sid=crimes#/shoplifting",
    "loader.php?sid=crimes#/pickpocketing", "loader.php?sid=crimes#/cardskimming",
    "loader.php?sid=crimes#/burglary", "loader.php?sid=crimes#/hustling",
    "loader.php?sid=crimes#/disposal", "loader.php?sid=crimes#/cracking",
    "loader.php?sid=crimes#/forgery", "loader.php?sid=crimes#/scamming",
    "page.php?sid=crimes#/arson", "page.php?sid=keepsakes",
    "page.php?sid=crimes2", "authenticate.php",
]

# Filler pool — always tried if no priority target is viable
FILLER_PRIORITY = ["cay", "mex"]

# Default priority targets — overwritten at startup by load_priorities()
# Edit via /priority in Telegram; persists to PRIORITIES_FILE
PRIORITY_TARGETS = [
    ("jap", "Xanax"),
    ("jap", "Cherry Blossom"),
]

# Auto-derived from PRIORITY_TARGETS — updated whenever priorities change
ITEM_PRIORITY   = list(dict.fromkeys(item for _, item in PRIORITY_TARGETS))
DEFAULT_COUNTRY = PRIORITY_TARGETS[0][0] if PRIORITY_TARGETS else "cay"

# Last winning run info — populated by pick_best_destination(), used for cash check + /status
_last_run_info: dict = {}

COUNTRY_BUY_STEPS = {
    "mex": [
        {
            "name":             "Jaguar Plushie",
            "max_selector":     "//form[@id='item-258-form']//span",
            "buy_selector":     "//button[@form='item-258-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Dahlia",
            "max_selector":     "//form[@id='item-260-form']//span",
            "buy_selector":     "//button[@form='item-260-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
    "cay": [
        {
            "name":             "Stingray Plushie",
            "max_selector":     "//form[@id='item-618-form']//span",
            "buy_selector":     "//button[@form='item-618-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Banana Orchid",
            "max_selector":     "//form[@id='item-617-form']//span",
            "buy_selector":     "//button[@form='item-617-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
    "can": [
        {
            "name":             "Wolverine Plushie",
            "max_selector":     "//form[@id='item-261-form']//span",
            "buy_selector":     "//button[@form='item-261-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Crocus",
            "max_selector":     "//form[@id='item-263-form']//span",
            "buy_selector":     "//button[@form='item-263-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Xanax",
            "max_selector":     "//form[@id='item-206-form']//span",
            "buy_selector":     "//button[@form='item-206-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
    "haw": [
        {
            "name":             "Orchid",
            "max_selector":     "//form[@id='item-264-form']//span",
            "buy_selector":     "//button[@form='item-264-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
    "uni": [
        {
            "name":             "Red Fox Plushie",
            "max_selector":     "//form[@id='item-268-form']//span",
            "buy_selector":     "//button[@form='item-268-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Nessie Plushie",
            "max_selector":     "//form[@id='item-266-form']//span",
            "buy_selector":     "//button[@form='item-266-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Heather",
            "max_selector":     "//form[@id='item-267-form']//span",
            "buy_selector":     "//button[@form='item-267-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Xanax",
            "max_selector":     "//form[@id='item-206-form']//span",
            "buy_selector":     "//button[@form='item-206-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
    "arg": [
        {
            "name":             "Monkey Plushie",
            "max_selector":     "//form[@id='item-269-form']//span",
            "buy_selector":     "//button[@form='item-269-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Ceibo Flower",
            "max_selector":     "//form[@id='item-271-form']//span",
            "buy_selector":     "//button[@form='item-271-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
    "swi": [
        {
            "name":             "Chamois Plushie",
            "max_selector":     "//form[@id='item-273-form']//span",
            "buy_selector":     "//button[@form='item-273-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Edelweiss",
            "max_selector":     "//form[@id='item-272-form']//span",
            "buy_selector":     "//button[@form='item-272-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
    "jap": [
        {
            "name":             "Xanax",
            "max_selector":     "//form[@id='item-206-form']//span",
            "buy_selector":     "//button[@form='item-206-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Cherry Blossom",
            "max_selector":     "//form[@id='item-277-form']//span",
            "buy_selector":     "//button[@form='item-277-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
    "chi": [
        {
            "name":             "Panda Plushie",
            "max_selector":     "//form[@id='item-274-form']//span",
            "buy_selector":     "//button[@form='item-274-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Peony",
            "max_selector":     "//form[@id='item-276-form']//span",
            "buy_selector":     "//button[@form='item-276-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
    "uae": [
        {
            "name":             "Camel Plushie",
            "max_selector":     "//form[@id='item-384-form']//span",
            "buy_selector":     "//button[@form='item-384-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Tribulus Omanense",
            "max_selector":     "//form[@id='item-385-form']//span",
            "buy_selector":     "//button[@form='item-385-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
    "sou": [
        {
            "name":             "Lion Plushie",
            "max_selector":     "//form[@id='item-281-form']//span",
            "buy_selector":     "//button[@form='item-281-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "African Violet",
            "max_selector":     "//form[@id='item-282-form']//span",
            "buy_selector":     "//button[@form='item-282-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
        {
            "name":             "Xanax",
            "max_selector":     "//form[@id='item-206-form']//span",
            "buy_selector":     "//button[@form='item-206-form']",
            "confirm_selector": "//button[normalize-space()='Yes']",
        },
    ],
}

COUNTRY_TRAVEL_SELECTORS = {
    "mex": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[1]//div[1]",
        "button":    "Travel to Mexico",
    },
    "cay": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[2]//div[1]",
        "button":    "Travel to Cayman Islands",
    },
    "can": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[3]//div[1]",
        "button":    "Travel to Canada",
    },
    "haw": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[4]//div[1]",
        "button":    "Travel to Hawaii",
    },
    "uni": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[5]//div[1]",
        "button":    "Travel to United Kingdom",
    },
    "arg": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[6]//div[1]",
        "button":    "Travel to Argentina",
    },
    "swi": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[7]//div[1]",
        "button":    "Travel to Switzerland",
    },
    "jap": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[8]//div[1]",
        "button":    "Travel to Japan",
    },
    "chi": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[9]//div[1]",
        "button":    "Travel to China",
    },
    "uae": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[10]//div[1]",
        "button":    "Travel to UAE",
    },
    "sou": {
        "map_label": "//fieldset[contains(@class,'worldMap___SvXMZ')]//label[11]//div[1]",
        "button":    "Travel to South Africa",
    },
}

# ── City name -> country code ─────────────────────────────────────────────────
# Source: wiki.torn.com (each country page lists its city)
# Parsed from flight progress text: "Torn to <City>" or "Returning to Torn"
CITY_TO_CC = {
    # Mexico       — Ciudad Juarez
    "ciudad ju":   "mex",
    # Canada       — Toronto
    "toronto":     "can",
    # Cayman Islands — George Town
    "george town": "cay",
    "cayman":      "cay",
    # Hawaii       — Honolulu
    "honolulu":    "haw",
    # United Kingdom — London
    "london":      "uni",
    # Switzerland  — Zurich
    "zurich":      "swi",
    # Argentina    — Buenos Aires
    "buenos aires":"arg",
    # Japan        — Tokyo
    "tokyo":       "jap",
    # China        — Beijing
    "beijing":     "chi",
    # UAE          — Dubai
    "dubai":       "uae",
    # South Africa — Johannesburg (was Cape Town prior to Jan 2026)
    "johannesburg":"sou",
    "cape town":   "sou",
}

# ─────────────────────────────────────────────
# Priority persistence
# ─────────────────────────────────────────────

KEEPALIVE_INTERVAL = 3600   # refresh browser every 60 min if idle


def keep_alive_browser(page):
    """
    Navigate to travel page if browser has been idle for KEEPALIVE_INTERVAL seconds.
    Call this in any idle loop (main loop, pause loop) to prevent CF challenge.
    Updates _last_activity_time on success.
    """
    global _last_activity_time
    if time.time() - _last_activity_time < KEEPALIVE_INTERVAL:
        return
    log("   🔄 Keep-alive: browser idle >60min — refreshing travel page...")
    try:
        page.goto("https://www.torn.com/page.php?sid=travel", wait_until="domcontentloaded", timeout=15000)
        check_and_solve_captcha(page)
        _last_activity_time = time.time()
        log("   ✅ Keep-alive: browser refreshed")
    except Exception as e:
        log(f"   ⚠️ Keep-alive failed: {e}")


def update_activity():
    """Call after any page action to reset the keep-alive timer."""
    global _last_activity_time
    _last_activity_time = time.time()



    """Load PRIORITY_TARGETS from disk. Falls back to hardcoded defaults."""
    global PRIORITY_TARGETS, ITEM_PRIORITY, DEFAULT_COUNTRY
    try:
        with open(PRIORITIES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        loaded = [(p["cc"], p["item"]) for p in data]
        if loaded:
            PRIORITY_TARGETS = loaded
            ITEM_PRIORITY    = list(dict.fromkeys(item for _, item in PRIORITY_TARGETS))
            DEFAULT_COUNTRY  = PRIORITY_TARGETS[0][0]
            log(f"   📂 Priorities loaded: {[f'{cc}:{item}' for cc, item in PRIORITY_TARGETS]}")
    except FileNotFoundError:
        log("   📂 No priorities file — using defaults")
    except Exception as e:
        log(f"   ⚠️ Could not load priorities: {e} — using defaults")


def load_priorities():
    """Load PRIORITY_TARGETS from disk. Falls back to hardcoded defaults."""
    global PRIORITY_TARGETS, ITEM_PRIORITY, DEFAULT_COUNTRY
    try:
        with open(PRIORITIES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        loaded = [(p["cc"], p["item"]) for p in data]
        if loaded:
            PRIORITY_TARGETS = loaded
            ITEM_PRIORITY    = list(dict.fromkeys(item for _, item in PRIORITY_TARGETS))
            DEFAULT_COUNTRY  = PRIORITY_TARGETS[0][0]
            log(f"   📂 Priorities loaded: {[f'{cc}:{item}' for cc, item in PRIORITY_TARGETS]}")
    except FileNotFoundError:
        log("   📂 No priorities file — using defaults")
    except Exception as e:
        log(f"   ⚠️ Could not load priorities: {e} — using defaults")


def save_priorities():
    """Save current PRIORITY_TARGETS to disk."""
    try:
        os.makedirs(os.path.dirname(PRIORITIES_FILE), exist_ok=True)
        data = [{"cc": cc, "item": item} for cc, item in PRIORITY_TARGETS]
        with open(PRIORITIES_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        log(f"   ⚠️ Could not save priorities: {e}")


# ─────────────────────────────────────────────
# Prometheus — live foreign stock fetch (single call, all countries)
# ─────────────────────────────────────────────

PROMETHEUS_URL = "https://prombot.co.uk:8443/api/travel"

_prometheus_cache: dict | None = None
_prometheus_cache_ts: float = 0
PROMETHEUS_CACHE_SECS = 55  # cache for 55s — refresh every ~1 min with cron

def fetch_prometheus_all() -> dict | None:
    """
    Fetch all countries from Prometheus in one call.
    Returns dict keyed by cc: {stocks: [...]} or None on failure.
    Caches result for 55 seconds.
    """
    global _prometheus_cache, _prometheus_cache_ts
    try:
        if _prometheus_cache and (time.time() - _prometheus_cache_ts) < PROMETHEUS_CACHE_SECS:
            return _prometheus_cache
        r = requests.get(PROMETHEUS_URL, timeout=15)
        r.raise_for_status()
        data = r.json()
        _prometheus_cache = data.get("stocks", {})
        _prometheus_cache_ts = time.time()
        log(f"   📡 Prometheus: fetched {len(_prometheus_cache)} countries")
        return _prometheus_cache
    except Exception as e:
        log(f"   ⚠️ Prometheus fetch failed: {e}")
        return _prometheus_cache  # return stale cache if available


def _get_item_from_prometheus(cc_data: dict, item_name: str) -> dict | None:
    """
    Find item by name in Prometheus country data.
    Normalizes to DroqsDB-compatible format:
      stock, buyPrice, estimatedRestockMinutes, itemName
    """
    for item in cc_data.get("stocks", []):
        if item.get("name") == item_name:
            # Calculate estimatedRestockMinutes from nextRestock datetime
            estimated_restock = None
            next_restock_iso  = item.get("nextRestock")
            if next_restock_iso:
                try:
                    from datetime import datetime, timezone
                    restock_dt  = datetime.fromisoformat(next_restock_iso.replace("Z", "+00:00"))
                    now_dt      = datetime.now(timezone.utc)
                    mins_until  = (restock_dt - now_dt).total_seconds() / 60
                    if 0 < mins_until < 1440:
                        estimated_restock = round(mins_until)
                except Exception:
                    pass
            return {
                "itemName":              item.get("name"),
                "stock":                 item.get("quantity", 0),
                "buyPrice":              item.get("cost", 0),
                "estimatedRestockMinutes": estimated_restock,
                "profitPerItem":         0,   # Prometheus doesn't provide profit
                "profitPerMinute":       0,
            }
    return None


# Keep old fetch_droqs_country as fallback (not called in normal flow)
def fetch_droqs_country(country_name: str) -> dict | None:
    """Legacy DroqsDB fetch — kept as fallback only."""
    try:
        url = DROQS_COUNTRY_URL.format(country=country_name.replace(" ", "%20"))
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            return None
        return data.get("country")
    except Exception as e:
        log(f"   ⚠️ DroqsDB fallback /country/{country_name} failed: {e}")
        return None


def _get_item_from_country(country_data: dict, item_name: str) -> dict | None:
    """Find a specific item — supports both DroqsDB and Prometheus formats."""
    # Prometheus format has 'stocks' key
    if "stocks" in country_data:
        return _get_item_from_prometheus(country_data, item_name)
    # DroqsDB format has 'items' key
    for item in country_data.get("items", []):
        if item.get("itemName") == item_name:
            return item
    return None


def _call_predict_api(cc: str, item_name: str) -> dict | None:
    """
    Call the stock tracker predict API.
    Returns response dict or None on failure.
    """
    try:
        r = requests.get(
            PREDICT_API_URL,
            params={
                "token":  PREDICT_API_TOKEN,
                "cc":     cc,
                "item":   item_name,
                "buffer": _settings.get("stock_buffer", -5),
            },
            timeout=5,
        )
        r.raise_for_status()
        data = r.json()
        if data.get("ok"):
            return data
    except Exception as e:
        log(f"      ⚠️ Predict API error for {item_name} ({cc}): {e}")
    return None


def _check_priority_viable(item: dict, cc: str) -> tuple[bool, float | None]:
    """
    Check if a priority item is worth flying to.
    Returns (fly_now, next_window_mins).

    Priority:
    1. Predict API (if confidence >= PREDICT_MIN_CONFIDENCE) — uses depletion history
    2. Fallback: estimatedRestockMinutes window logic

    War mode: only fly if stock > 0 regardless of source.
    """
    stock     = item.get("stock", 0)
    item_name = item.get("itemName", "")
    flight_mins = FLIGHT_TIMES.get(cc, {}).get("seconds", 0) / 60

    # War mode — stock only, no waiting
    if WAR_MODE:
        if stock > 0:
            log(f"      ✅ {item_name}: stock={stock} WAR MODE — fly now")
            return True, None
        log(f"      ❌ {item_name}: empty + WAR MODE — skip")
        return False, None

    # ── Try predict API first ──────────────────────────────────────────────
    pred = _call_predict_api(cc, item_name)
    if pred and pred.get("confidence", 0) >= PREDICT_MIN_CONFIDENCE:
        fly          = pred.get("fly")
        reason       = pred.get("reason", "")
        next_window  = pred.get("nextWindowMins")
        confidence   = pred.get("confidence", 0)
        analysis     = pred.get("analysis", {})
        runway       = analysis.get("stockRunway")
        restock_eta  = analysis.get("nextRestockEta")

        log(f"      🔮 {item_name} [{cc}] predict: fly={fly} conf={confidence} buf={_settings.get('stock_buffer',0)}m — {reason}")
        if runway:  log(f"         stock runway={runway}m flight={flight_mins:.0f}m")
        if restock_eta: log(f"         next restock eta={restock_eta}m")

        if fly is True:
            return True, None
        elif fly is False:
            return False, next_window
        # fly=None means API has data but can't decide — fall through to fallback

    else:
        if pred:
            log(f"      📉 {item_name}: predict confidence={pred.get('confidence',0)} < {PREDICT_MIN_CONFIDENCE} — using fallback")
        else:
            log(f"      📉 {item_name}: predict API unavailable — using fallback")

    # ── Fallback: estimatedRestockMinutes window ───────────────────────────
    restock_mins = item.get("estimatedRestockMinutes")
    win_early, win_late = ITEM_RESTOCK_WINDOWS.get(
        item_name, (RESTOCK_WINDOW_EARLY, RESTOCK_WINDOW_LATE)
    )

    if stock > 0:
        log(f"      ✅ {item_name}: stock={stock} — fly now (fallback)")
        return True, None

    if restock_mins is None:
        log(f"      ❌ {item_name}: empty, no restock ETA (fallback)")
        return False, None

    window = restock_mins - flight_mins
    log(f"      📊 {item_name}: restock={restock_mins}m flight={flight_mins:.0f}m window={window:.1f}m [{win_early},{win_late}] (fallback)")

    if win_early <= window <= win_late:
        log(f"      ✅ Window [{win_early},{win_late}] — fly now (fallback)")
        return True, window
    else:
        log(f"      ❌ Window {window:.1f}m outside [{win_early},{win_late}] (fallback)")
        return False, restock_mins - flight_mins


def _log_run_info(item: dict, cc: str):
    """Log a clean one-line summary of the winning item/country."""
    country  = FLIGHT_TIMES.get(cc, {}).get("name", cc)
    name     = item.get("itemName", "?")
    buy      = item.get("buyPrice", 0)
    cost     = buy * 29
    ppi      = item.get("profitPerItem", 0)
    profit   = ppi * 29
    ppm      = item.get("profitPerMinute", 0)
    restock  = item.get("estimatedRestockMinutes")
    rst_str  = f"restock ~{restock}m" if restock else "in stock"
    log(
        f"   💰 {country} | {name} | "
        f"Cost: {cost:,.0f} | Profit: {profit:,.0f} | "
        f"{ppm:,.0f}/min | {rst_str}"
    )


# ─────────────────────────────────────────────
# Destination picker
# ─────────────────────────────────────────────

def pick_best_destination() -> str | None:
    """
    Smart travel scheduler using DroqsDB /country/:country per priority country.

    Step 1 -- Priority check:
              Fetch each unique country in PRIORITY_TARGETS.
              For each item: check stock or restock window [-5,+15] (normal) / stock only (war).
              First viable → fly.

    Step 2 -- Recheck loop (normal mode only):
              If a priority item has restock window = 0 (depart now but not in stock yet):
              Poll every 60s up to 5min until stock > 0.

    Step 3 -- Find soonest priority window (gap):
              next_depart_mins = soonest restock window across non-viable priorities.
              None for all → infinity → fillers fly freely.

    Step 4 -- Filler check:
              round_trip + 15min buffer < next_depart_mins AND stock > 0 → fly filler.

    Step 5 -- Default Cayman: next_depart_mins = infinity AND no viable filler.

    Step 6 -- Stay home: window known but no filler fits.
    """
    global _last_run_info
    DEPART_WAIT_SECS = 300   # max 5 min wait for restock

    log("   🌍 Smart scheduler -- evaluating...")

    # ── Fetch all countries from Prometheus in ONE call ───────────────────
    all_stocks = fetch_prometheus_all()
    if not all_stocks:
        log("   ⚠️ Prometheus unavailable — staying home this cycle")
        return None

    # Build country_data dict keyed by cc using Prometheus data
    country_data: dict[str, dict] = {}
    for cc, _ in PRIORITY_TARGETS:
        if cc not in country_data and cc in all_stocks:
            country_data[cc] = all_stocks[cc]
            log(f"   📦 {FLIGHT_TIMES.get(cc,{}).get('name',cc)}: {len(all_stocks[cc].get('stocks',[]))} items fetched")

    if not country_data:
        log("   ⚠️ No priority country data — staying home this cycle")
        return None

    # ── Step 1: priority check ────────────────────────────────────────────
    near_window_targets = []   # items where restock is very close (for step 2)
    gap_windows = []           # known restock windows for gap calc

    for cc, item_name in PRIORITY_TARGETS:
        cdata = country_data.get(cc)
        if not cdata:
            continue
        item = _get_item_from_country(cdata, item_name)
        if not item:
            log(f"   ⚠️ {item_name} not found in {FLIGHT_TIMES.get(cc,{}).get('name',cc)} response")
            continue

        fly, window = _check_priority_viable(item, cc)

        # Not viable — use returned window for gap calc
        if fly:
            _last_run_info = {
                "itemName":        item_name,
                "country":         FLIGHT_TIMES.get(cc, {}).get("name", cc),
                "buyPrice":        item.get("buyPrice", 0),
                "profitPerItem":   item.get("profitPerItem", 0),
                "profitPerMinute": item.get("profitPerMinute", 0),
                "marginMinutes":   item.get("estimatedRestockMinutes"),
                "availabilityState": "in_stock" if item.get("stock", 0) > 0 else "restock_window",
                "timingTight":     window is not None and abs(window) < 5,
            }
            _log_run_info(item, cc)
            log(f"   ✅ Priority -- flying {FLIGHT_TIMES.get(cc, {}).get('name', cc)}")
            return cc

        # Not viable — calculate gap using estimatedRestockMinutes from DroqsDB
        # This is the time until next restock, which defines how long we have for a filler
        restock_mins = item.get("estimatedRestockMinutes")
        if window is not None and window > 0:
            # Predict API gave us optimal depart window — use it
            gap_windows.append(window)
        elif restock_mins is not None:
            flight_mins = FLIGHT_TIMES.get(cc, {}).get("seconds", 0) / 60
            w = restock_mins - flight_mins
            if -2 <= w <= 2:
                near_window_targets.append((cc, item_name, item))
            # Always add restock_mins as gap — filler must return before restock
            gap_windows.append(restock_mins)
        else:
            # Fallback to estimatedRestockMinutes if no window from API
            restock_mins = item.get("estimatedRestockMinutes")
            if restock_mins is not None:
                flight_mins = FLIGHT_TIMES.get(cc, {}).get("seconds", 0) / 60
                w = restock_mins - flight_mins
                if -2 <= w <= 2:
                    near_window_targets.append((cc, item_name, item))
                if w > RESTOCK_WINDOW_LATE:
                    gap_windows.append(restock_mins)

    # ── Step 2: recheck loop for near-window targets (normal mode only) ──
    if near_window_targets and not WAR_MODE:
        log(f"   ⏳ Near-window targets: {[i for _,i,_ in near_window_targets]} — waiting up to 5min...")
        wait_start = time.time()
        while time.time() - wait_start < DEPART_WAIT_SECS:
            time.sleep(60)
            elapsed = int(time.time() - wait_start)
            log(f"   🔄 Rechecking ({elapsed}s elapsed)...")
            for cc, item_name, _ in near_window_targets:
                country_name = FLIGHT_TIMES.get(cc, {}).get("name", cc)
                fresh_all = fetch_prometheus_all()
                if not fresh_all:
                    continue
                fresh_cc = fresh_all.get(cc, {})
                item = _get_item_from_prometheus(fresh_cc, item_name) if fresh_cc else None
                if item and item.get("stock", 0) > 0:
                    _last_run_info = {
                        "itemName":        item_name,
                        "country":         country_name,
                        "buyPrice":        item.get("buyPrice", 0),
                        "profitPerItem":   item.get("profitPerItem", 0),
                        "profitPerMinute": item.get("profitPerMinute", 0),
                        "marginMinutes":   0,
                        "availabilityState": "in_stock",
                        "timingTight":     False,
                    }
                    _log_run_info(item, cc)
                    log(f"   ✅ Priority now in stock after wait -- flying {country_name}")
                    return cc
        log("   ⏱ 5min cap hit — proceeding to filler check")

    # ── Step 3: gap calculation ───────────────────────────────────────────
    next_depart_mins = min(gap_windows) if gap_windows else None
    if next_depart_mins is not None:
        log(f"   ⏳ Soonest priority restock: {next_depart_mins}m — checking fillers")
    else:
        log("   ⏳ No known priority window — fillers fly freely")

    # ── Step 4: filler check ─────────────────────────────────────────────
    for filler_cc in FILLER_PRIORITY:
        filler_name  = FLIGHT_TIMES.get(filler_cc, {}).get("name", filler_cc)
        # Fetch filler country if not already fetched
        if filler_cc not in country_data and filler_cc in (all_stocks or {}):
            country_data[filler_cc] = all_stocks[filler_cc]

        fdata = country_data.get(filler_cc)
        if not fdata:
            log(f"   🔄 Filler {filler_name}: no data")
            continue

        for step in COUNTRY_BUY_STEPS.get(filler_cc, []):
            item = _get_item_from_country(fdata, step["name"])
            if not item:
                continue

            # Use same predict API logic as priority items
            fly, window = _check_priority_viable(item, filler_cc)
            if not fly:
                log(f"   🔄 Filler {filler_name} | {step['name']}: not viable")
                continue

            flight_mins     = FLIGHT_TIMES[filler_cc]["seconds"] / 60
            round_trip_mins = flight_mins * 2 + (BUY_TIME_SECS / 60)
            fits = (
                next_depart_mins is None or
                (round_trip_mins + FILLER_BUFFER_MINS) < next_depart_mins
            )
            log(f"   🔄 Filler {filler_name} | {step['name']}: stock={item.get('stock',0)} round_trip={round_trip_mins:.0f}m fits={'✅' if fits else '❌'}")
            if fits:
                _last_run_info = {
                    "itemName":          step["name"],
                    "country":           filler_name,
                    "buyPrice":          item.get("buyPrice", 0),
                    "profitPerItem":     item.get("profitPerItem", 0),
                    "profitPerMinute":   item.get("profitPerMinute", 0),
                    "marginMinutes":     None,
                    "availabilityState": "in_stock",
                    "timingTight":       False,
                }
                _log_run_info(item, filler_cc)
                log(f"   ✅ Filler -- flying {filler_name}")
                return filler_cc
        log(f"   🔄 Filler {filler_name}: no viable item")

    # ── Step 5: default Cayman ────────────────────────────────────────────
    if next_depart_mins is None:
        log("   ⚠️ No viable runs, no priority window — defaulting to Cayman (anti-mug)")
        _last_run_info = {}
        return "cay"

    # ── Step 6: stay home ─────────────────────────────────────────────────
    log(f"   ⏸ Priority restock in {next_depart_mins}m, no filler fits — staying home")
    _last_run_info = {}
    return None
# ─────────────────────────────────────────────
# Location helpers
# ─────────────────────────────────────────────

def _match_country_from_text(text: str) -> str | None:
    """Returns country code if any known city/country name is found in text."""
    for city, cc in CITY_TO_CC.items():
        if city in text:
            return cc
    country_names = {v["name"].lower(): k for k, v in FLIGHT_TIMES.items()}
    for name, cc in country_names.items():
        if name in text:
            return cc
    return None


def get_travel_destination(page) -> str | None:
    """
    Detects current destination using two signals:
      A — flight progress span (in-flight or just landed)
      B — h4 country heading (abroad, after landing)
    Returns country code, "home", or None.
    """
    # ── Signal A: flight progress text ───────────────────────────────────────
    try:
        el = page.locator("//span[@class='progressTextLineBreaker___yl1NA']")
        if el.count() > 0:
            text = el.first.inner_text(timeout=2000).strip().lower()
            log(f"   ✈️  Flight progress: '{text}'")
            if "returning to torn" in text or "torn city" in text or "to torn" in text:
                return "home"
            cc = _match_country_from_text(text)
            if cc:
                log(f"   🗺  Flight→ {FLIGHT_TIMES[cc]['name']}")
                return cc
            log(f"   ⚠️  Unknown destination in flight text: '{text}'")
    except Exception as e:
        log(f"   ⚠️  Flight progress error: {e}")

    # ── Signal B: h4 country heading (abroad, post-landing) ──────────────────
    try:
        for cc, info in FLIGHT_TIMES.items():
            h4 = page.locator(f"h4:has-text('{info['name']}')")
            if h4.count() > 0:
                log(f"   🗺  h4 heading → abroad at {info['name']}")
                return cc
    except Exception as e:
        log(f"   ⚠️  h4 country check error: {e}")

    return None


def detect_location(page) -> str:
    """
    Returns: 'hospital' | 'traveling' | 'abroad' | 'home'

    Detection order (most specific first):
      hospital  = aria-label Hospital nav link, h4 Hospital heading, or alert div
      traveling = <time datetime> countdown element visible
      abroad    = "Travel home" button OR h4 country heading
      home      = default fallback
    """
    try:
        # ── 1. Hospital check — highest priority ─────────────────────────────
        if page.locator("//a[starts-with(@aria-label,'Hospital:')]").count() > 0:
            return "hospital"

        if page.locator("h4:has-text('Hospital')").count() > 0:
            return "hospital"

        alert = page.locator("div[role='alert']")
        if alert.count() > 0:
            try:
                alert_text = alert.first.inner_text(timeout=1000)
                if "hospital" in alert_text.lower():
                    return "hospital"
            except Exception:
                pass

        abroad_alert = page.locator(
            "//div[contains(@class,'info-msg-cont') and contains(@class,'red')]//div[@role='alert']"
        )
        if abroad_alert.count() > 0:
            try:
                abroad_text = abroad_alert.first.inner_text(timeout=1000)
                if "hospital" in abroad_text.lower():
                    return "hospital"
            except Exception:
                pass

        # ── 2. In-flight countdown ────────────────────────────────────────────
        if page.locator("time[datetime]").count() > 0:
            return "traveling"

        # ── 3. Abroad — two independent POSITIVE signals ─────────────────────
        if page.get_by_role("button", name="Travel home").count() > 0:
            return "abroad"
        for info in FLIGHT_TIMES.values():
            if page.locator(f"h4:has-text('{info['name']}')").count() > 0:
                return "abroad"

        # ── 4. Safe default: home ─────────────────────────────────────────────
        return "home"

    except Exception:
        return "home"


def is_home(page) -> bool:
    loc = detect_location(page)
    return loc in ("home", "hospital")   # hospitalized = still in Torn City


# ─────────────────────────────────────────────
# Hospital detection
# ─────────────────────────────────────────────

def _parse_time_text(text: str) -> int:
    """
    Parses any combination of hours/minutes/seconds from a string.
    Returns total seconds, or 0 if nothing found.
    """
    total = 0
    h = re.search(r"(\d+)\s*hour",   text, re.IGNORECASE)
    m = re.search(r"(\d+)\s*minute", text, re.IGNORECASE)
    s = re.search(r"(\d+)\s*second", text, re.IGNORECASE)
    if h: total += int(h.group(1)) * 3600
    if m: total += int(m.group(1)) * 60
    if s: total += int(s.group(1))
    return total


def parse_hospital_time(page) -> int | None:
    """
    Returns remaining hospital seconds, or None if not in hospital.

    Checks four sources in priority order:
      1. span#theCounter        — home hospital: live HH:MM:SS or MM:SS clock
      2. Abroad timer span      — abroad hospital: "X minutes and Y seconds" text
      3. Alert div (any)        — both home and abroad: full sentence with time
      4. h4 heading only        — hospitalized abroad with no timer visible yet
    """
    try:
        # ── 1. span#theCounter ────────────────────────────────────────────────
        counter = page.locator("//span[@id='theCounter']")
        if counter.count() > 0:
            try:
                raw   = counter.first.inner_text(timeout=1000).strip()
                total = 0
                parts = raw.split(":")
                if len(parts) == 3:
                    total = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                elif len(parts) == 2:
                    total = int(parts[0]) * 60 + int(parts[1])
                else:
                    total = _parse_time_text(raw)
                if total > 0:
                    log(f"   🏥 #theCounter: {raw!r} = {total}s")
                    return total
            except Exception as e:
                log(f"   ⚠️ theCounter parse error: {e}")

        # ── 2. Abroad timer span ──────────────────────────────────────────────
        if page.locator("h4:has-text('Hospital')").count() > 0:
            for span in page.locator("span").all():
                try:
                    t = span.inner_text(timeout=500).strip()
                    if ("minute" in t.lower() or "second" in t.lower()) and any(c.isdigit() for c in t):
                        secs = _parse_time_text(t)
                        if secs > 0:
                            log(f"   🏥 Abroad timer span: '{t}' = {secs}s")
                            return secs
                except Exception:
                    continue

        # ── 3. Alert div ──────────────────────────────────────────────────────
        alert = page.locator(
            "//div[contains(@class,'info-msg-cont') and contains(@class,'red')]//div[@role='alert']"
            " | //div[@role='alert']"
        ).first
        if alert.count() > 0:
            try:
                text = alert.inner_text(timeout=2000)
                if "hospital" in text.lower():
                    secs = _parse_time_text(text)
                    if secs > 0:
                        log(f"   🏥 Alert text parsed: {secs}s")
                        return secs
                    log(f"   🏥 Hospital alert (no time): {text[:120]}")
                    return 60
            except Exception:
                pass

        # ── 4. h4 only — no timer yet ─────────────────────────────────────────
        if page.locator("h4:has-text('Hospital')").count() > 0:
            log("   🏥 Abroad hospital page detected (no timer yet) — rechecking in 60s")
            return 60

        return None

    except Exception as e:
        log(f"   ⚠️ parse_hospital_time error: {e}")
        return None


def check_and_wait_hospital(page) -> bool:
    """
    Checks if in hospital. If so, live-tracks the countdown every 10s
    by re-reading the page timer — no blind sleeping. Returns True if was hospitalized.
    """
    try:
        if "torn.com" not in page.url:
            page.goto("https://www.torn.com/index.php", wait_until="domcontentloaded")
            reading_pause(800, 1500)
            check_and_solve_captcha(page)
    except Exception:
        pass

    secs = parse_hospital_time(page)
    if secs is None:
        return False

    abroad_hospital = page.locator("h4:has-text('Hospital')").count() > 0
    reload_url      = page.url if abroad_hospital else "https://www.torn.com/index.php"
    context_label   = "abroad hospital" if abroad_hospital else "home hospital"

    log(f"\n🏥 IN HOSPITAL ({context_label}) — {secs // 60}m {secs % 60}s remaining. Tracking live...")

    # Live countdown — read span#theCounter directly, no page reload needed.
    # Torn updates it in real-time via JS. Poll every 10s, faster near release.
    while True:
        try:
            counter = page.locator("span#theCounter")
            if counter.count() > 0:
                raw = counter.inner_text().strip()
                # Parse HH:MM:SS or MM:SS
                parts = raw.split(":")
                if len(parts) == 3:
                    secs = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                elif len(parts) == 2:
                    secs = int(parts[0]) * 60 + int(parts[1])
                else:
                    secs = 0
            else:
                # Counter gone — released
                secs = 0
        except Exception:
            secs = 0

        if secs <= 0:
            log("   ✅ Released from hospital! Reloading...")
            try:
                page.goto("https://www.torn.com/index.php", wait_until="domcontentloaded", timeout=10000)
                reading_pause(600, 1000)
                check_and_solve_captcha(page)
            except Exception as e:
                log(f"   ⚠️ Post-hospital reload error: {e}")
            log("   ✅ Back home after hospital\n")
            return True

        h = secs // 3600
        m = (secs % 3600) // 60
        s = secs % 60
        if h > 0:
            time_str = f"{h}h {m}m {s}s"
        elif m > 0:
            time_str = f"{m}m {s}s"
        else:
            time_str = f"{s}s"

        log(f"   🏥 Hospital: {time_str} remaining...")

        # Poll faster near release
        time.sleep(min(10, max(3, secs - 2)))

# ─────────────────────────────────────────────
# Randomized thresholds
# ─────────────────────────────────────────────

def roll_energy_threshold() -> int:
    val = random.randint(ENERGY_MIN, ENERGY_MAX)
    log(f"🎲 New energy threshold: {val} (range {ENERGY_MIN}–{ENERGY_MAX})")
    return val

def roll_nerve_trigger() -> int:
    # Auto-derive from SELECTED_CRIMES — never trigger if we can't afford the crime
    try:
        costs = []
        for cat, sub in SELECTED_CRIMES:
            if cat in CRIME_CATALOGUE:
                nerve = next((n for (label, n) in CRIME_CATALOGUE[cat] if label == sub), None)
                if nerve:
                    costs.append(nerve)
        val = min(costs) if costs else 4
    except Exception:
        val = 4
    log(f"🎲 New nerve threshold: {val}")
    return val

# ─────────────────────────────────────────────
# Human-like delays
# ─────────────────────────────────────────────

def human_pause(min_ms: float = 300, max_ms: float = 900):
    time.sleep(random.uniform(min_ms, max_ms) / 1000)

def reading_pause(min_ms: float = 800, max_ms: float = 2200):
    time.sleep(random.uniform(min_ms, max_ms) / 1000)

def typo_chance_pause():
    if random.random() < 0.15:
        extra = random.uniform(0.5, 2.0)
        log(f"   🤔 Hesitation ({extra:.1f}s)...")
        time.sleep(extra)

def human_click(locator):
    human_pause(100, 400)
    locator.hover()
    human_pause(80, 350)
    typo_chance_pause()
    locator.click()

def human_fill(locator, text: str):
    locator.click()
    human_pause(200, 500)
    for char in text:
        locator.press(char)
        time.sleep(random.uniform(0.05, 0.22))
    human_pause(100, 300)

def hourly_sleep():
    total = int(random.randint(10, 15) + random.uniform(-2, 5))
    h, m, s = total // 3600, (total % 3600) // 60, total % 60
    log(f"\n😴 Next scan in {h}h {m}m {s}s...\n")
    slept = 0
    while slept < total:
        chunk = min(300, total - slept)
        time.sleep(chunk)
        slept += chunk
        rem = total - slept
        if rem > 0:
            log(f"   ⏰ {rem // 3600}h {(rem % 3600) // 60}m remaining...")

# ─────────────────────────────────────────────
# CAPTCHA — reCAPTCHA helpers (unchanged from original)
# ─────────────────────────────────────────────

def capsolver_solve_recaptcha_v2() -> str | None:
    log("   🤖 Submitting reCAPTCHA to CapSolver...")
    try:
        resp = requests.post(
            "https://api.capsolver.com/createTask",
            json={"clientKey": CAPSOLVER_API_KEY, "task": {
                "type": "ReCaptchaV2TaskProxyless",
                "websiteURL": PAGE_URL,
                "websiteKey": RECAPTCHA_SITE_KEY,
            }}, timeout=15,
        ).json()
        if resp.get("errorId") != 0:
            log(f"   ❌ CapSolver error: {resp.get('errorDescription')}")
            return None
        task_id = resp["taskId"]
        log(f"   ✅ Task created: {task_id}")
        for attempt in range(30):
            time.sleep(5)
            result = requests.post(
                "https://api.capsolver.com/getTaskResult",
                json={"clientKey": CAPSOLVER_API_KEY, "taskId": task_id},
                timeout=10,
            ).json()
            if result.get("errorId") != 0:
                return None
            log(f"   ⏳ {result.get('status')} ({attempt+1}/30)")
            if result.get("status") == "ready":
                return result["solution"]["gRecaptchaResponse"]
        return None
    except Exception as e:
        log(f"   ⚠️ CapSolver error: {e}")
        return None


def inject_recaptcha_token(page, token: str) -> bool:
    try:
        page.evaluate("""
            (token) => {
                const ta = document.querySelector('#g-recaptcha-response');
                if (ta) { ta.style.display='block'; ta.value=token; }
                try {
                    const clients = ___grecaptcha_cfg.clients;
                    const w = clients[Object.keys(clients)[0]];
                    for (const k of Object.keys(w)) {
                        const n = w[k];
                        if (n && typeof n==='object') {
                            for (const sk of Object.keys(n)) {
                                if (typeof n[sk]==='function' && sk==='callback') { n[sk](token); return; }
                            }
                        }
                    }
                } catch(e) {}
                const ta2 = document.querySelector('#g-recaptcha-response');
                if (ta2) ta2.dispatchEvent(new Event('change', {bubbles:true}));
            }
        """, token)
        log("   ✅ Token injected")
        return True
    except Exception as e:
        log(f"   ⚠️ inject token error: {e}")
        return False


def js_click_continue(page) -> bool:
    try:
        clicked = page.evaluate(
            "() => { const b=document.querySelector(\"input[value='CONTINUE']\"); if(b){b.click();return true;} return false; }"
        )
        if clicked:
            try: page.wait_for_load_state("domcontentloaded", timeout=5000)
            except Exception: pass
            return True
        return False
    except Exception:
        return False


def try_click_recaptcha_checkbox(page) -> bool:
    page.wait_for_timeout(2000)
    try:
        frame = page.frame_locator('iframe[title="reCAPTCHA"]')
        cb = frame.locator('#recaptcha-anchor')
        cb.wait_for(timeout=4000)
        cb.hover()
        human_pause(300, 700)
        cb.click()
        log("   ✅ Checkbox clicked")
    except Exception as e:
        log(f"   ⚠️ Checkbox error: {e}")
        return False

    page.wait_for_timeout(2500)
    if page.locator('iframe[title="recaptcha challenge expires in two minutes"]').count() == 0:
        log("   🎉 Passed instantly!")
        js_click_continue(page)
        return True

    log("   🖼️ Image challenge — calling CapSolver...")
    token = capsolver_solve_recaptcha_v2()
    if not token or not inject_recaptcha_token(page, token):
        return False

    page.wait_for_timeout(1500)
    if js_click_continue(page):
        page.wait_for_timeout(2000)
        return True

    page.evaluate("() => { const f=document.querySelector('form'); if(f) f.submit(); }")
    try: page.wait_for_load_state("domcontentloaded", timeout=15000)
    except Exception: pass
    page.wait_for_timeout(2000)
    return True


# ─────────────────────────────────────────────
# CAPTCHA — Cloudflare detection
# ─────────────────────────────────────────────

def _is_cf_managed_challenge(page) -> bool:
    """
    Detects CF MANAGED challenge — animated 'Just a moment...' dots page.
    cType: 'managed' — no visible checkbox, browser JS fingerprint auto-solves it.
    Signals: page title, iAmUnderAttack div, _cf_chl_opt + orchestrate in source.
    """
    try:
        if "just a moment" in page.title().lower():
            return True
        if page.locator("div.iAmUnderAttack").count() > 0:
            return True
        content = page.content()
        if "_cf_chl_opt" in content and "orchestrate/chl_page" in content:
            return True
        if '"managed"' in content and "challenge-platform" in content:
            return True
        return False
    except Exception:
        return False


def _is_cf_interactive_turnstile(page) -> bool:
    """
    Detects CF INTERACTIVE Turnstile — 'Verify you are human' checkbox in an iframe.
    cType: 'interactive' — has a visible Cloudflare challenge iframe with a checkbox.
    Signals: CF challenge iframe src, cb-lb-t span, 'interactive' in source.
    """
    try:
        if page.locator('iframe[src*="challenges.cloudflare.com"]').count() > 0:
            return True
        if page.locator("span.cb-lb-t").count() > 0:
            return True
        content = page.content()
        if '"interactive"' in content and "_cf_chl_opt" in content:
            return True
        return False
    except Exception:
        return False



THEYKA_PROFILE_DIR = r"C:\temp\theyka-solver-profile"   # clean profile for Theyka solver

def theyka_solve_turnstile(page_url: str, site_key: str, timeout: int = 30) -> str | None:
    """
    Solves Cloudflare Turnstile locally using a SEPARATE clean patchright browser.
    Runs in its own thread to avoid the "sync API inside asyncio loop" error that
    occurs when nesting sync_playwright() inside the main bot's playwright context.
    """
    HTML_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
    <title>CF Solver</title>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
    <div id="result" style="display:none"></div>
    <!-- cf turnstile -->
    <script>
        window._cfToken = null;
        function onCFCallback(token) {
            window._cfToken = token;
            document.getElementById('result').innerText = token;
        }
    </script>
</body>
</html>"""

    turnstile_div = (
        f'<div class="cf-turnstile" '
        f'data-sitekey="{site_key}" '
        f'data-callback="onCFCallback">'
        f'</div>'
    )
    page_data = HTML_TEMPLATE.replace("<!-- cf turnstile -->", turnstile_div)

    result_holder = [None]   # mutable container so the thread can write back

    def _run():
        try:
            with sync_playwright() as p:
                context = p.chromium.launch_persistent_context(
                    THEYKA_PROFILE_DIR,
                    headless=False,
                    no_viewport=True,
                    args=[
                        "--no-first-run",
                        "--no-default-browser-check",
                        "--disable-blink-features=AutomationControlled",
                        "--window-size=420,240",
                        "--window-position=0,0",
                        "--lang=en-US,en",
                    ],
                    locale="en-US",
                )
                solver_page = context.new_page()

                # set_content is more reliable than route intercept —
                # avoids DNS, network, and route-matching issues entirely
                try:
                    solver_page.set_content(page_data, wait_until="domcontentloaded")
                    # Override the page URL so CF's JS sees the correct origin
                    solver_page.evaluate(f"""() => {{
                        try {{ history.replaceState(null, '', '{page_url}'); }} catch(e) {{}}
                    }}""")
                except Exception as nav_err:
                    log(f"   ⚠️ Theyka set_content error: {nav_err}")
                    context.close()
                    return

                # Give widget time to load
                time.sleep(3)

                # The CF Turnstile widget renders as an iframe inside our fake HTML page.
                # Patchright may auto-solve managed/invisible widgets, but interactive ones
                # (showing a checkbox) need a click. Try both approaches:
                #   1. Playwright frame_locator on the CF iframe inside solver_page
                #   2. Raw mouse click at the known checkbox position in the iframe
                try:
                    frame = solver_page.frame_locator('iframe[src*="challenges.cloudflare.com"]').first
                    cb = frame.locator('input[type="checkbox"]').first
                    if cb.count() > 0:
                        cb.wait_for(state="attached", timeout=5000)
                        cb.click(timeout=5000)
                        log("   🖱️  Theyka: clicked interactive checkbox via frame_locator")
                    else:
                        # Fallback: click by iframe bbox coords
                        iframe_el = solver_page.locator('iframe[src*="challenges.cloudflare.com"]').first
                        if iframe_el.count() > 0:
                            bbox = iframe_el.bounding_box()
                            if bbox:
                                cx = bbox["x"] + 30
                                cy = bbox["y"] + bbox["height"] / 2
                                solver_page.mouse.move(cx - 8, cy)
                                time.sleep(0.2)
                                solver_page.mouse.click(cx, cy)
                                log(f"   🖱️  Theyka: raw click at ({cx:.0f}, {cy:.0f})")
                except Exception as click_err:
                    log(f"   ⚠️  Theyka checkbox click: {click_err}")
                    # Patchright may still auto-solve it — keep polling

                start = time.time()
                deadline = start + timeout
                while time.time() < deadline:
                    time.sleep(0.5)
                    try:
                        token = solver_page.evaluate("() => window._cfToken || null")
                        if token:
                            log(f"   ✅ Theyka solved in {time.time()-start:.1f}s")
                            result_holder[0] = token
                            context.close()
                            return
                    except Exception:
                        pass

                log("   ❌ Theyka solver timed out")
                context.close()
        except Exception as e:
            log(f"   ⚠️ Theyka thread error: {e}")

    log("   🤖 Theyka solver: spawning clean patchright instance (thread)...")
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=timeout + 10)   # +10s grace for browser startup
    return result_holder[0]


def capsolver_solve_turnstile(page_url: str, site_key: str) -> str | None:
    """
    Solves Cloudflare Turnstile. Tries Theyka local solver first (free, ~4-6s),
    falls back to CapSolver API if Theyka fails.
    """
    # ── Method 1: Theyka local solver — clean patchright instance ────────
    token = theyka_solve_turnstile(page_url, site_key)
    if token:
        return token
    log("   ⚠️ Theyka failed — falling back to CapSolver API...")

    # ── Method 2: CapSolver API ───────────────────────────────────────────
    log("   🤖 Submitting Turnstile to CapSolver...")
    try:
        resp = requests.post(
            "https://api.capsolver.com/createTask",
            json={"clientKey": CAPSOLVER_API_KEY, "task": {
                "type": "AntiTurnstileTaskProxyLess",
                "websiteURL": page_url,
                "websiteKey": site_key,
            }}, timeout=15,
        ).json()
        if resp.get("errorId") != 0:
            log(f"   ❌ CapSolver Turnstile error: {resp.get('errorDescription')}")
            return None
        task_id = resp["taskId"]
        log(f"   ✅ Turnstile task: {task_id}")
        for attempt in range(30):
            time.sleep(5)
            result = requests.post(
                "https://api.capsolver.com/getTaskResult",
                json={"clientKey": CAPSOLVER_API_KEY, "taskId": task_id},
                timeout=10,
            ).json()
            if result.get("errorId") != 0:
                return None
            log(f"   ⏳ {result.get('status')} ({attempt+1}/30)")
            if result.get("status") == "ready":
                return result["solution"].get("token")
        return None
    except Exception as e:
        log(f"   ⚠️ CapSolver Turnstile error: {e}")
        return None




def _try_solve_interactive_turnstile(page) -> bool:
    """
    Solves the CF interactive Turnstile (checkbox widget) via three cascading methods:

    Method 1 — frame_locator click:
        Playwright's cross-frame click on the checkbox input directly.

    Method 2 — Raw mouse coordinates:
        Gets the iframe bounding box and clicks at the checkbox position (~25px
        from left, vertically centred). Bypasses element-level bot detection since
        it simulates a real physical mouse click at actual screen coordinates.

    Method 3 — CapSolver API:
        Extracts sitekey from the iframe src URL (?k=...) or page HTML,
        sends to CapSolver, injects the returned token and submits.
    """
    log("   🔲 Solving interactive Turnstile (checkbox)...")

    # ── Method 1: frame_locator click ────────────────────────────────────────
    try:
        frame = page.frame_locator('iframe[src*="challenges.cloudflare.com"]').first
        cb = frame.locator('input[type="checkbox"]').first
        cb.wait_for(state="attached", timeout=4000)
        cb.click(timeout=4000)
        time.sleep(3)
        if not _is_cf_interactive_turnstile(page):
            log("   ✅ Passed via frame_locator click")
            return True
    except Exception as e:
        log(f"   ⚠️ frame_locator click: {e}")

    # ── Method 2: Raw mouse coordinates ──────────────────────────────────────
    # The Turnstile checkbox is always ~25px from the left edge of the iframe,
    # vertically centred. We find the iframe bbox and click at that position.
    try:
        iframe_el = page.locator('iframe[src*="challenges.cloudflare.com"]').first
        bbox = iframe_el.bounding_box()
        if bbox:
            cx = bbox["x"] + 25
            cy = bbox["y"] + bbox["height"] / 2
            log(f"   🖱  Raw mouse click at ({cx:.0f}, {cy:.0f})...")
            page.mouse.move(cx - 8, cy - 4)   # approach from nearby (human-like)
            time.sleep(random.uniform(0.2, 0.5))
            page.mouse.click(cx, cy)
            time.sleep(4)
            if not _is_cf_interactive_turnstile(page):
                log("   ✅ Passed via raw mouse click")
                return True
    except Exception as e:
        log(f"   ⚠️ Raw mouse click: {e}")

    # ── Method 3: CapSolver — extract sitekey from iframe src ────────────────
    try:
        iframe_src = page.evaluate("""() => {
            const f = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
            return f ? f.src : null;
        }""")
        site_key = None
        if iframe_src:
            m = re.search(r"[?&]k=([0-9a-zA-Z_\-]{20,})", iframe_src)
            if m:
                site_key = m.group(1)
        if not site_key:
            html = page.content()
            m = re.search(r"[?&]k=([0-9a-zA-Z_\-]{20,})", html)
            if m:
                site_key = m.group(1)

        if site_key:
            log(f"   🔑 Sitekey: {site_key[:25]}...")
            token = capsolver_solve_turnstile(page.url, site_key)
            if token:
                page.evaluate("""(token) => {
                    const inputs = document.querySelectorAll('[name="cf-turnstile-response"]');
                    for (const inp of inputs) inp.value = token;
                    // fire the turnstile success callback if available
                    if (window.turnstile) {
                        try { window.turnstile.implicitRender(); } catch(e) {}
                    }
                    if (window._cfRenderCb && typeof window._cfRenderCb === 'function') {
                        try { window._cfRenderCb(token); } catch(e) {}
                    }
                    const form = document.querySelector('form');
                    if (form) form.submit();
                }""", token)
                time.sleep(4)
                if not _is_cf_interactive_turnstile(page):
                    log("   ✅ Passed via CapSolver token")
                    return True
        else:
            log("   ⚠️ Could not extract sitekey for CapSolver")
    except Exception as e:
        log(f"   ⚠️ CapSolver interactive: {e}")

    return False


def _extract_sitekey_from_page(page) -> str | None:
    """
    Extracts the Turnstile sitekey from current page WITHOUT any navigation.
    Tries multiple strategies since CF injects the key different ways.
    """
    try:
        el = page.locator("[data-sitekey]").first
        if el.count() > 0:
            sk = el.get_attribute("data-sitekey")
            if sk:
                log(f"   🔑 Sitekey via data-sitekey: {sk[:25]}...")
                return sk
    except Exception:
        pass
    try:
        html = page.content()
        # _cf_chl_opt object — e.g. cSitekey:"0x4..."
        m = re.search(r'cSitekey["\']?\s*:\s*["\']([0-9a-zA-Z_\-]{20,})', html)
        if m:
            log(f"   🔑 Sitekey via _cf_chl_opt: {m.group(1)[:25]}...")
            return m.group(1)
        # turnstile script URL ?sitekey=...
        m = re.search(r'[?&]sitekey=([0-9a-zA-Z_\-]{20,})', html)
        if m:
            log(f"   🔑 Sitekey via script URL: {m.group(1)[:25]}...")
            return m.group(1)
        # any 0x4... value (CF sitekeys always start with 0x4)
        m = re.search(r'(0x4[0-9a-zA-Z_\-]{18,})', html)
        if m:
            log(f"   🔑 Sitekey via 0x4 pattern: {m.group(1)[:25]}...")
            return m.group(1)
    except Exception as e:
        log(f"   ⚠️ Sitekey extraction error: {e}")
    return None


def _inject_token_and_submit(page, token: str):
    """Injects a solved Turnstile token into the page and triggers submission."""
    page.evaluate("""(token) => {
        const inputs = document.querySelectorAll(
            '[name="cf-turnstile-response"], [id$="_response"][type="hidden"]'
        );
        for (const inp of inputs) inp.value = token;
        if (window._cfRenderCb && typeof window._cfRenderCb === 'function') {
            try { window._cfRenderCb(token); } catch(e) {}
        }
        if (window.turnstile) {
            try { window.turnstile.implicitRender(); } catch(e) {}
        }
        const form = document.querySelector('form');
        if (form) form.submit();
    }""", token)


def _try_solve_managed_challenge(page) -> bool:
    """
    Handles CF managed challenge ('Just a moment...' animated dots).

    Waits 40s, restores the CDP-controlled Brave window (identified by PID
    from the CDP /json/version endpoint — unaffected by other open Brave
    instances), fires a ghost click at page centre, minimizes, then restarts.

    Windows : ShowWindow + PostMessage WM_LBUTTONDOWN/UP.
    Linux   : xdotool windowactivate/windowminimize + click --window.
    """
    try:
        log("   ⏳ Waiting 40s then ghost-clicking centre of page...")
        time.sleep(40)

        # ── Get viewport geometry from page ──────────────────────────────────
        info = page.evaluate("""() => ({
            vw: window.innerWidth,
            vh: window.innerHeight,
            chrome_h: window.outerHeight - window.innerHeight,
        })""")
        vw       = info["vw"]
        vh       = info["vh"]
        chrome_h = info["chrome_h"]

        cx = int(vw / 2)
        cy = int(vh / 2) - 30

        # ── Identify the CDP browser's PID via /json/version ─────────────────
        try:
            version_info = requests.get(f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=3).json()
            cdp_pid = int(version_info.get("webSocketDebuggerUrl", "").split("/")[2].split(":")[0]
                          if False else 0)  # placeholder — real PID below
        except Exception:
            cdp_pid = None

        # More reliable: spawn a quick CDP call to get browser process ID
        try:
            import urllib.request
            data = json.loads(urllib.request.urlopen(
                f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=3
            ).read())
            # Browser user-agent contains no PID, but we can get it from the
            # process list by matching the --remote-debugging-port argument
            cdp_pid = None
            for proc_line in subprocess.check_output(
                ["tasklist", "/FI", f"IMAGENAME eq brave.exe", "/FO", "CSV"],
                text=True
            ).splitlines()[1:] if sys.platform == "win32" else []:
                pass  # handled below per platform
        except Exception:
            cdp_pid = None

        if sys.platform == "win32":
            import ctypes

            user32 = ctypes.windll.user32
            SW_RESTORE  = 9
            SW_MINIMIZE = 6

            # ── Find CDP Brave PID via WMIC matching --remote-debugging-port ──
            try:
                out = subprocess.check_output(
                    ["wmic", "process", "where",
                     f"name='brave.exe' and commandline like '%remote-debugging-port={DEBUG_PORT}%'",
                     "get", "processid", "/format:list"],
                    text=True, stderr=subprocess.DEVNULL
                )
                pids = [int(l.split("=")[1]) for l in out.splitlines()
                        if l.startswith("ProcessId=") and l.split("=")[1].strip().isdigit()]
                cdp_pid = pids[0] if pids else None
                log(f"   🔍 CDP Brave PID: {cdp_pid}")
            except Exception as e:
                log(f"   ⚠️ PID lookup failed: {e} — falling back to title search")
                cdp_pid = None

            class RECT(ctypes.Structure):
                _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                            ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

            class POINT(ctypes.Structure):
                _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

            found_hwnd = ctypes.c_int(0)

            def enum_cb(hwnd, _):
                if not user32.IsWindowVisible(hwnd):
                    return True
                buf = ctypes.create_unicode_buffer(256)
                cls = ctypes.create_unicode_buffer(256)
                user32.GetWindowTextW(hwnd, buf, 256)
                user32.GetClassNameW(hwnd, cls, 256)
                if "Chrome_WidgetWin_1" not in cls.value:
                    return True

                if cdp_pid is not None:
                    # Match by PID — ignores any other Brave windows
                    pid = ctypes.c_ulong(0)
                    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                    if pid.value == cdp_pid:
                        found_hwnd.value = hwnd
                else:
                    # Fallback: title match
                    if any(k in buf.value for k in ["Brave", "torn.com", "Just a moment",
                                                     "Cloudflare", "Verify", "Checking"]):
                        found_hwnd.value = hwnd
                return True

            WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_int, ctypes.c_int)
            user32.EnumWindows(WNDENUMPROC(enum_cb), 0)

            if not found_hwnd.value:
                raise RuntimeError("CDP Brave window not found")

            hwnd = found_hwnd.value

            # Restore and bring to front
            user32.ShowWindow(hwnd, SW_RESTORE)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.5)

            brave_rect = RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(brave_rect))
            screen_x = brave_rect.left + cx
            screen_y = brave_rect.top + chrome_h + cy
            log(f"   🪟 CDP Brave at ({brave_rect.left}, {brave_rect.top}), "
                f"chrome_h={chrome_h}px, viewport={vw}x{vh}")

            pt = POINT(screen_x, screen_y)
            user32.ScreenToClient(hwnd, ctypes.byref(pt))
            lParam = (pt.y << 16) | (pt.x & 0xFFFF)

            WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON = 0x0201, 0x0202, 0x0001
            log(f"   🖱️  Ghost click → client ({pt.x}, {pt.y})")
            user32.PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lParam)
            time.sleep(random.uniform(0.05, 0.15))
            user32.PostMessageW(hwnd, WM_LBUTTONUP, 0, lParam)
            log("   🖱️  Ghost click fired (Windows PostMessage)")

            time.sleep(5)
            user32.ShowWindow(hwnd, SW_MINIMIZE)
            log("   🪟 CDP Brave minimized")

        else:
            # ── Linux: find by PID via /proc, then xdotool ───────────────────
            try:
                cdp_pid = None
                for pid_dir in os.listdir("/proc"):
                    if not pid_dir.isdigit():
                        continue
                    try:
                        cmdline = open(f"/proc/{pid_dir}/cmdline").read().replace("\x00", " ")
                        if "brave" in cmdline.lower() and f"remote-debugging-port={DEBUG_PORT}" in cmdline:
                            cdp_pid = int(pid_dir)
                            break
                    except Exception:
                        continue
                log(f"   🔍 CDP Brave PID: {cdp_pid}")
            except Exception as e:
                log(f"   ⚠️ Linux PID lookup failed: {e}")
                cdp_pid = None

            if cdp_pid:
                result = subprocess.run(
                    ["xdotool", "search", "--pid", str(cdp_pid)],
                    capture_output=True, text=True
                )
            else:
                result = subprocess.run(
                    ["xdotool", "search", "--name",
                     "Brave\\|torn.com\\|Just a moment\\|Cloudflare\\|Verify\\|Checking"],
                    capture_output=True, text=True
                )

            wids = result.stdout.strip().splitlines()
            if not wids:
                raise RuntimeError("CDP Brave window not found via xdotool")

            wid = wids[-1].strip()
            log(f"   🪟 CDP Brave window id: {wid}, viewport={vw}x{vh}")

            subprocess.run(["xdotool", "windowactivate", "--sync", wid], check=True)
            time.sleep(0.5)

            log(f"   🖱️  Ghost click → ({cx}, {cy + chrome_h})")
            subprocess.run(
                ["xdotool", "mousemove", "--window", wid,
                 str(cx), str(cy + chrome_h),
                 "click", "--window", wid, "1"],
                check=True
            )
            log("   🖱️  Ghost click fired (Linux xdotool)")

            time.sleep(5)
            subprocess.run(["xdotool", "windowminimize", wid])
            log("   🪟 CDP Brave minimized")

        # Always restart after click
        log("   ♻️  Restarting program in 5s (Brave untouched)...")
        time.sleep(5)
        _restart_program()

    except Exception as e:
        log(f"   ⚠️ Managed challenge ghost click error: {e}")

    return False

def check_and_solve_captcha(page) -> bool:
    """
    Detects and solves any challenge blocking the page. Retries up to 3 times.

    Detection order:
      1. CF Managed challenge     — 'Just a moment...' dots  (cType: managed)
      2. CF Interactive Turnstile — checkbox in iframe        (cType: interactive)
      3. Google reCAPTCHA v2      — original Torn login captcha
    """
    for attempt in range(3):
        try:
            # ── CF Managed challenge ──────────────────────────────────────────
            if _is_cf_managed_challenge(page):
                log(f"\n🛡️  CF managed challenge (attempt {attempt+1})")
                if _try_solve_managed_challenge(page):
                    log("✅ CF managed challenge cleared\n")
                    time.sleep(2)
                    try: page.wait_for_load_state("domcontentloaded", timeout=5000)
                    except Exception: pass
                    return True
                log(f"❌ CF managed challenge failed (attempt {attempt+1})\n")
                time.sleep(5)
                continue

            # ── CF Interactive Turnstile (checkbox) ───────────────────────────
            if _is_cf_interactive_turnstile(page):
                log(f"\n🛡️  CF interactive Turnstile (attempt {attempt+1})")
                if _try_solve_interactive_turnstile(page):
                    log("✅ CF interactive Turnstile cleared\n")
                    time.sleep(2)
                    try: page.wait_for_load_state("domcontentloaded", timeout=5000)
                    except Exception: pass
                    return True
                log(f"❌ CF interactive Turnstile failed (attempt {attempt+1})\n")
                time.sleep(3)
                continue

            # ── Google reCAPTCHA v2 ───────────────────────────────────────────
            if page.locator('iframe[title="reCAPTCHA"]').count() == 0:
                return True
            log("\n🔒 reCAPTCHA detected!")
            result = try_click_recaptcha_checkbox(page)
            if result:
                log("✅ CAPTCHA solved\n")
            else:
                log("❌ CAPTCHA failed — trying JS CONTINUE\n")
                js_click_continue(page)
            return result

        except Exception as e:
            log(f"⚠️ captcha error (attempt {attempt+1}): {e}")
            time.sleep(2)

    return False

# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def parse_fraction(text: str) -> tuple[int, int] | None:
    m = re.search(r"(\d+)\s*/\s*(\d+)", text)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def parse_travel_time(page) -> int | None:
    try:
        el = page.locator("time[datetime]").first
        el.wait_for(timeout=5000)
        dt = el.get_attribute("datetime")
        if not dt:
            return None
        h = int(re.search(r"(\d+)h", dt).group(1)) if re.search(r"(\d+)h", dt) else 0
        m = int(re.search(r"(\d+)m", dt).group(1)) if re.search(r"(\d+)m", dt) else 0
        s = int(re.search(r"(\d+)s", dt).group(1)) if re.search(r"(\d+)s", dt) else 0
        return h * 3600 + m * 60 + s
    except Exception as e:
        log(f"   ⚠️ parse_travel_time error: {e}")
        return None


def get_current_nerve(page) -> int | None:
    # Try desktop nav bar first (index.php)
    try:
        el = page.locator("a.bar___Bv5Ho.nerve___AyYv_.bar-desktop___p5Cas p.bar-value___NTdce")
        el.wait_for(timeout=2000)
        parsed = parse_fraction(el.inner_text().strip())
        if parsed:
            return parsed[0]
    except Exception:
        pass
    # Fallback: any nerve bar on page (crimes.php compact nav)
    try:
        el = page.locator("a.nerve___AyYv_ p.bar-value___NTdce").first
        el.wait_for(timeout=2000)
        parsed = parse_fraction(el.inner_text().strip())
        if parsed:
            return parsed[0]
    except Exception:
        pass
    return None


def get_current_energy(page) -> int | None:
    try:
        el = page.locator("a.bar___Bv5Ho.energy___hsTnO.bar-desktop___p5Cas p.bar-value___NTdce")
        el.wait_for(timeout=5000)
        parsed = parse_fraction(el.inner_text().strip())
        return parsed[0] if parsed else None
    except Exception:
        return None

# ─────────────────────────────────────────────
# Page state detection
# ─────────────────────────────────────────────

def detect_page_state(page) -> str:
    """
    Identifies the current page and logs it clearly.

    Returns one of:
      'otp'          — Torn 2FA / OTP entry page (authenticate.php)
      'login'        — Torn login page (not yet signed in)
      'cf_managed'   — Cloudflare 'Just a moment...' managed challenge
      'cf_turnstile' — Cloudflare interactive Turnstile checkbox
      'home'         — In-game, at home in Torn City
      'traveling'    — In-flight
      'abroad'       — Landed abroad
      'hospital'     — Hospitalized
      'unknown'      — Unrecognised page
    """
    try:
        url = page.url

        # OTP / 2FA page — check URL and input element
        if "authenticate.php" in url or page.locator("#verify-code-input").count() > 0:
            log("   📄 Page: OTP / 2FA verification")
            return "otp"

        # CF challenges — before login check so CF on login page is handled correctly
        if _is_cf_managed_challenge(page):
            log("   📄 Page: Cloudflare managed challenge ('Just a moment...')")
            return "cf_managed"
        if _is_cf_interactive_turnstile(page):
            log("   📄 Page: Cloudflare Turnstile (checkbox)")
            return "cf_turnstile"

        # Login page — energy bar absent, Login button present
        if (page.locator('button:has-text("Login")').count() > 0
                or page.locator('[name="btnLogin"]').count() > 0):
            log("   📄 Page: Login page (not authenticated)")
            return "login"

        # In-game pages — energy bar present means logged in
        if page.locator("a.bar___Bv5Ho.energy___hsTnO").count() > 0:
            loc = detect_location(page)
            labels = {
                "home":      "In-game — home",
                "traveling": "In-game — in-flight",
                "abroad":    "In-game — abroad",
                "hospital":  "In-game — hospital",
            }
            log(f"   📄 Page: {labels.get(loc, f'In-game ({loc})')}")
            return loc

        log(f"   📄 Page: Unknown ({url[:80]})")
        return "unknown"

    except Exception as e:
        log(f"   ⚠️ detect_page_state error: {e}")
        return "unknown"

def random_page_browse(page, label: str = ""):
    nav_options = [
        ("🎒 Items",       "//a[@href='/item.php']"),
        ("🏋️ Gym",         "//a[@href='/gym.php']"),
        ("💊 Pharmacy",    "//a[@href='/shops.php?step=pharmacy']"),
        ("🍬 Sweet Shop",  "//a[@href='/shops.php?step=candy']"),
        # FIX: use specific desktop nav class to avoid strict mode violation
        ("🏠 Home",        "a.desktopLink___SG2RU[href='/index.php']"),
        ("📋 Missions",    "//a[@href='/loader.php?sid=missions']"),
        ("📰 Newspaper",   "//a[@href='/newspaper.php']"),
        ("🏠 Properties",  "//a[@href='/properties.php']"),
    ]
    num_pages = random.randint(1, 3)
    chosen    = random.sample(nav_options, num_pages)
    tag       = f"[{label}] " if label else ""
    log(f"\n   🌐 {tag}Browsing {num_pages} random page(s)...")

    for name, selector in chosen:
        try:
            time.sleep(random.uniform(3.0, 8.0))
            typo_chance_pause()
            locator = page.locator(selector).first
            if locator.count() == 0:
                continue
            log(f"   👆 Visiting {name}...")
            human_click(locator)
            time.sleep(random.uniform(5.0, 15.0))
            if random.random() < 0.5:
                scroll_px = random.randint(150, 500)
                page.mouse.wheel(0, scroll_px)
                time.sleep(random.uniform(1.5, 4.0))
                page.mouse.wheel(0, -scroll_px)
            check_and_solve_captcha(page)
        except Exception as e:
            log(f"   ⚠️ Could not visit {name}: {e}")

    log(f"   ✅ {tag}Done browsing\n")

# ─────────────────────────────────────────────
# Nerve — crimes
# ─────────────────────────────────────────────

def _resolve_crime() -> tuple[str, str, int]:
    """
    Pick next (category, subcategory, nerve_cost) from SELECTED_CRIMES.
    Validates against CRIME_CATALOGUE. Raises ValueError on bad config.
    """
    global _crime_index

    if not SELECTED_CRIMES:
        raise ValueError("SELECTED_CRIMES is empty — enable at least one crime in config.")

    if CRIME_SELECTION == "sequential":
        cat, sub = SELECTED_CRIMES[_crime_index % len(SELECTED_CRIMES)]
        _crime_index += 1
    else:
        cat, sub = random.choice(SELECTED_CRIMES)

    if cat not in CRIME_CATALOGUE:
        raise ValueError(f"Category '{cat}' not found in CRIME_CATALOGUE.")
    nerve = next((n for (label, n) in CRIME_CATALOGUE[cat] if label == sub), None)
    if nerve is None:
        raise ValueError(f"Subcategory '{sub}' not found under '{cat}' in CRIME_CATALOGUE.")

    return cat, sub, nerve



def nerve_action(page):
    loc = detect_location(page)
    if loc != "home":
        log(f"🧠 Skipping crimes — currently {loc}, not at home")
        return

    try:
        category, subcategory, min_nerve = _resolve_crime()
    except ValueError as e:
        log(f"⚠️ Crime config error: {e}")
        return

    log(f"🧠 Nerve threshold met — crime: [{category}] → [{subcategory}] ({min_nerve}N)")

    reading_pause()

    # Navigate directly — more reliable than clicking nav link
    page.goto("https://www.torn.com/crimes.php", wait_until="domcontentloaded")
    reading_pause(500, 1200)
    check_and_solve_captcha(page)
    page.wait_for_timeout(random.randint(800, 1800))
    reading_pause(500, 1500)

    try:
        page.locator(f'label:has-text("{category}")').wait_for(timeout=5000)
        human_click(page.locator(f'label:has-text("{category}")'))
        human_pause(300, 900)
    except Exception as e:
        log(f"   ⚠️ Category '{category}' not found: {e}")
        return
    try:
        page.locator(f'label:has-text("{subcategory}")').wait_for(timeout=5000)
        human_click(page.locator(f'label:has-text("{subcategory}")'))
        reading_pause(400, 1100)
    except Exception as e:
        log(f"   ⚠️ Subcategory '{subcategory}' not found: {e}")
        return
    try:
        page.locator('button:has-text("DO CRIME")').wait_for(timeout=5000)
        human_click(page.locator('button:has-text("DO CRIME")'))
        log("   ✅ Crime done")
    except Exception as e:
        log(f"   ⚠️ DO CRIME not found: {e}")
        return
    human_pause(600, 1400)
    check_and_solve_captcha(page)
    while True:
        current_nerve = get_current_nerve(page)
        log(f"   🧠 Nerve: {current_nerve}")
        if current_nerve is None or current_nerve < min_nerve:
            log(f"   💤 Nerve low — done with [{subcategory}]")
            break
        reading_pause(600, 1500)
        try:
            btn = page.locator('button:has-text("TRY AGAIN")')
            btn.wait_for(timeout=5000)
            human_click(btn)
        except Exception as e:
            log(f"   ⚠️ TRY AGAIN not found: {e}")
            break
        human_pause(800, 1800)
        check_and_solve_captcha(page)
    log("   🧠 Crime loop complete — returning to main loop")


# ─────────────────────────────────────────────
# Nerve — WAR MODE (zero fluff, pure speed)
# ─────────────────────────────────────────────
# Use during faction wars. No pre/post browsing,
# no random delays — only minimum waits needed
# for the page to respond reliably.
# To activate: replace nerve_action(page) call
# in the main loop with war_nerve_action(page).
# ─────────────────────────────────────────────

def war_nerve_action(page):
    loc = detect_location(page)
    if loc != "home":
        log(f"⚔️ [WAR] Skipping — currently {loc}, not at home")
        return

    try:
        category, subcategory, min_nerve = _resolve_crime()
    except ValueError as e:
        log(f"⚠️ [WAR] Crime config error: {e}")
        return

    log(f"⚔️ [WAR] Crime: [{category}] → [{subcategory}] ({min_nerve}N)")

    page.goto("https://www.torn.com/crimes.php", wait_until="domcontentloaded")
    page.wait_for_timeout(300)
    check_and_solve_captcha(page)

    try:
        page.locator(f'label:has-text("{category}")').wait_for(timeout=5000)
        war_click(page.locator(f'label:has-text("{category}")'))
        war_jitter(100, 200)
    except Exception as e:
        log(f"   ⚠️ [WAR] Category '{category}' not found: {e}")
        return
    try:
        page.locator(f'label:has-text("{subcategory}")').wait_for(timeout=5000)
        war_click(page.locator(f'label:has-text("{subcategory}")'))
        war_jitter(200, 400)
    except Exception as e:
        log(f"   ⚠️ [WAR] Subcategory '{subcategory}' not found: {e}")
        return
    try:
        page.locator('button:has-text("DO CRIME")').wait_for(timeout=5000)
        war_click(page.locator('button:has-text("DO CRIME")'))
        log("   ✅ [WAR] Crime done")
    except Exception as e:
        log(f"   ⚠️ [WAR] DO CRIME not found: {e}")
        return
    war_jitter(300, 600)
    check_and_solve_captcha(page)
    while True:
        current_nerve = get_current_nerve(page)
        log(f"   ⚔️ [WAR] Nerve: {current_nerve}")
        if current_nerve is None or current_nerve < min_nerve:
            log(f"   💤 [WAR] Nerve low — done with [{subcategory}]")
            break
        war_jitter(100, 200)
        try:
            btn = page.locator('button:has-text("TRY AGAIN")')
            btn.wait_for(timeout=5000)
            war_click(btn)
        except Exception as e:
            log(f"   ⚠️ [WAR] TRY AGAIN not found: {e}")
            break
        war_jitter(200, 400)
        check_and_solve_captcha(page)
    log("   ⚔️ [WAR] Crime loop complete — returning to main loop")


# ─────────────────────────────────────────────
# WAR MODE — shared micro primitives
# ─────────────────────────────────────────────
# war_jitter()  : 50–150ms pause — just enough for JS to settle
# war_click()   : raw click with 1–3px mouse offset for minimal humanization

def war_jitter(min_ms: int = 50, max_ms: int = 150):
    page_timeout = random.randint(min_ms, max_ms)
    time.sleep(page_timeout / 1000)

def war_click(locator):
    """Click with tiny randomized offset — micro-human, near-instant."""
    try:
        box = locator.bounding_box()
        if box:
            offset_x = box["width"]  / 2 + random.uniform(-2, 2)
            offset_y = box["height"] / 2 + random.uniform(-2, 2)
            war_jitter(30, 80)
            locator.click(position={"x": offset_x, "y": offset_y})
        else:
            locator.click()
    except Exception as e:
        log(f"   ⚠️ war_click fallback: {e}")
        locator.click()


# ─────────────────────────────────────────────
# WAR MODE — gym
# ─────────────────────────────────────────────

def war_gym(page):
    loc = detect_location(page)
    if loc != "home":
        log(f"⚔️ [WAR] Skipping gym — currently {loc}, not at home")
        return

    log("⚔️ [WAR] Gym — entering")

    gym_link = page.locator('a:has-text("Gym")')
    gym_link.wait_for(timeout=5000)
    war_click(gym_link)
    war_jitter(100, 200)
    check_and_solve_captcha(page)

    page.locator('xpath=//p[normalize-space()="What would you like to train today?"]').wait_for(timeout=5000)
    war_jitter(100, 200)

    stats = {
        "strength":  page.locator("li[class='strength___UwX1Y'] span[class='propertyValue___wopyE']"),
        "speed":     page.locator("li[class='speed___qNMTy'] span[class='propertyValue___wopyE']"),
        "defense":   page.locator("li[class='defense___LITyA'] span[class='propertyValue___wopyE']"),
        "dexterity": page.locator("li[class='dexterity___6ayVQ'] span[class='propertyValue___wopyE']"),
    }
    stat_values = {}
    for name, locator in stats.items():
        locator.wait_for(timeout=5000)
        stat_values[name] = float(locator.inner_text().strip().replace(",", ""))

    log(f"   💪 Str:{stat_values['strength']} ⚡ Spd:{stat_values['speed']} "
        f"🛡 Def:{stat_values['defense']} 🎯 Dex:{stat_values['dexterity']}")

    normalized  = {s: stat_values[s] / TARGET_RATIO[s] for s in stat_values}
    train_stat  = min(normalized, key=normalized.get)
    log(f"   🏆 [WAR] Training: {train_stat}")

    TRAIN_INPUTS = {
        "strength":  "//input[@aria-label='Enter the number of strength training']",
        "defense":   "//input[@aria-label='Enter the number of defense training']",
        "dexterity": "//input[@aria-label='Enter the number of dexterity training']",
        "speed":     "//input[@aria-label='Enter the number of speed training']",
    }

    try:
        inp = page.locator(f"xpath={TRAIN_INPUTS[train_stat]}")
        inp.wait_for(state="visible", timeout=5000)
        inp.fill(str(TRAIN_POINTS))
        war_jitter(80, 150)
    except Exception as e:
        log(f"   ⚠️ [WAR] Could not fill {train_stat} input ({e})")

    train_button = page.locator(f"button[aria-label='Train {train_stat}']")
    train_button.wait_for(timeout=5000)
    war_click(train_button)
    log(f"   ✅ [WAR] Trained {train_stat} x{TRAIN_POINTS}")
    war_jitter(100, 200)
    check_and_solve_captcha(page)


# ─────────────────────────────────────────────
# WAR MODE — buy items at destination
# ─────────────────────────────────────────────

def war_buy_items_at_destination(page, cc: str) -> bool:
    steps = COUNTRY_BUY_STEPS.get(cc, [])
    steps_ordered = sorted(
        steps,
        key=lambda s: ITEM_PRIORITY.index(s["name"]) if s["name"] in ITEM_PRIORITY else 99
    )

    bought_any = False

    for step in steps_ordered:
        name = step["name"]
        log(f"   🛍 [WAR] Buying: {name}")
        try:
            max_loc = page.locator(step["max_selector"]).first
            max_loc.wait_for(state="attached", timeout=6000)
            page.evaluate("el => el.click()", max_loc.element_handle())
            time.sleep(1)

            buy_loc = page.locator(step["buy_selector"]).first
            buy_loc.wait_for(state="attached", timeout=6000)
            page.evaluate("el => el.click()", buy_loc.element_handle())
            time.sleep(1)

            confirm_loc = page.locator(step["confirm_selector"]).first
            confirm_loc.wait_for(state="visible", timeout=6000)
            war_click(confirm_loc)
            time.sleep(1)

            log(f"   ✅ [WAR] Bought: {name}")
            bought_any = True

        except Exception as e:
            log(f"   ⚠️ [WAR] Could not buy {name}: {e} — skipping")

    if not bought_any:
        log("   ❌ [WAR] No items in stock — heading home")

    return bought_any


# ─────────────────────────────────────────────
# WAR MODE — travel
# ─────────────────────────────────────────────

def war_travel_action(page):
    loc = detect_location(page)
    if loc != "home":
        log(f"   ⚔️ [WAR] Skipping travel — currently {loc}, not at home")
        return

    log("\n⚔️ [WAR] Starting travel action...")

    cc = pick_best_destination()
    if cc is None:
        log("   ⏸ [WAR] No viable destination — skipping travel this cycle")
        return
    sel  = COUNTRY_TRAVEL_SELECTORS[cc]
    name = FLIGHT_TIMES[cc]["name"]

    # ── Cash check ─────────────────────────────────────────────────────────
    try:
        cash_el   = page.locator("//span[@id='user-money']")
        cash_el.wait_for(timeout=3000)
        cash      = int(cash_el.get_attribute("data-money") or 0)
        _settings["last_cash"] = cash
        save_settings()
        buy_price = int(_last_run_info.get("buyPrice", 0))
        run_cost  = buy_price * 29

        if run_cost > 0:
            if _settings.get("fly_low_cash"):
                # Fly regardless — war mode override
                log(f"   ⚠️ [WAR] Low cash override ON | Cash: {cash:,} | Need: {run_cost:,}")
            elif cash >= run_cost:
                after = cash - run_cost
                log(f"   💵 [WAR] Cash: {cash:,} ✅ | Cost: {run_cost:,} | After: {after:,}")
                _tg_send(f"💰 Your cash is enough for this important travel boss!\n"
                         f"💵 Cash: {cash:,} | Cost: {run_cost:,} | After: {after:,}")
            else:
                short = run_cost - cash
                log(f"   ⚠️ [WAR] INSUFFICIENT CASH! Have: {cash:,} | Need: {run_cost:,} | Short: {short:,}")
                # Try re-evaluating — maybe a cheaper destination fits
                cc_new = pick_best_destination()
                if cc_new:
                    new_cost = int(_last_run_info.get("buyPrice", 0)) * 29
                    if new_cost == 0 or cash >= new_cost:
                        log(f"   🔄 [WAR] Switching to cheaper destination: {FLIGHT_TIMES.get(cc_new,{}).get('name',cc_new)}")
                        cc   = cc_new
                        sel  = COUNTRY_TRAVEL_SELECTORS[cc]
                        name = FLIGHT_TIMES[cc]["name"]
                    else:
                        _tg_send(f"⚠️ <b>INSUFFICIENT CASH!</b>\n"
                                 f"Have : {cash:,}\n"
                                 f"Need : {run_cost:,}\n"
                                 f"Short: {short:,}\n"
                                 f"Use /resumeflight to force fly or add cash.")
                        log("   ⏸ [WAR] Skipping travel — insufficient cash. Gym/crimes continue.")
                        return
                else:
                    return
        else:
            log(f"   💵 [WAR] Cash: {cash:,} (no cost data)")
    except Exception as e:
        log(f"   ⚠️ [WAR] Could not read cash: {e}")
    # ── Nerve check — do crimes first if nerve ready ───────────────────────
    try:
        nerve_now = get_current_nerve(page)
        trigger   = _nerve_trigger_now or 0
        if nerve_now is not None and nerve_now >= trigger and trigger > 0:
            log(f"   🧠 [WAR] Nerve {nerve_now} >= {trigger} — doing crimes before flight")
            war_nerve_action(page)
            log("   🔄 [WAR] Re-evaluating destination after crimes...")
            cc = pick_best_destination()
            if cc is None:
                log("   ⏸ [WAR] No viable destination after nerve — skipping travel")
                return
            sel  = COUNTRY_TRAVEL_SELECTORS[cc]
            name = FLIGHT_TIMES[cc]["name"]
        else:
            log(f"   🧠 [WAR] Nerve {nerve_now}/{trigger} — no action needed")
    except Exception as e:
        log(f"   ⚠️ [WAR] Nerve check failed: {e}")

    page.goto("https://www.torn.com/page.php?sid=travel", wait_until="domcontentloaded")
    radio = page.locator(sel["map_label"])
    radio.wait_for(timeout=8000)
    war_click(radio)
    war_jitter(100, 200)

    travel_btn = page.get_by_role("button", name=sel["button"])
    travel_btn.wait_for(timeout=5000)
    war_click(travel_btn)
    log(f"   ✅ [WAR] Clicked '{sel['button']}'")
    war_jitter(150, 300)

    continue_btn = page.get_by_role("button", name="Continue")
    continue_btn.wait_for(timeout=8000)
    war_click(continue_btn)
    log("   ✅ [WAR] Clicked Continue (dialog)")
    war_jitter(150, 300)

    # ── Dirty bomb / terror attack block — airspace closed ───────────────────
    block_msg = page.locator(".responseMessage___w0GSG")
    if block_msg.count() > 0:
        try:
            msg_text = block_msg.first.inner_text(timeout=2000).strip().lower()
        except Exception:
            msg_text = ""
        block_keywords = ["closed", "cannot", "blocked", "unavailable", "attack", "bomb"]
        if any(kw in msg_text for kw in block_keywords):
            log(f"   🚫 [WAR] Travel blocked: '{msg_text}' — skipping travel this cycle")
            return

    # ── Airstrip — proceed to flight ─────────────────────────────────────────
    try:
        airstrip_btn = page.get_by_role("link", name="Continue")
        airstrip_btn.wait_for(timeout=8000)
        war_click(airstrip_btn)
        log("   ✅ [WAR] Airstrip — now flying!")
        _settings["flight_destination"] = name
        _settings["flight_eta"] = int(time.time()) + FLIGHT_TIMES[cc]["seconds"]
        save_settings()
    except Exception as e:
        log(f"   🚫 [WAR] Airstrip Continue not found ({e}) — travel blocked, skipping")
        return   # keep looping energy/nerve, no wipe

    check_and_solve_captcha(page)
    wait_for_arrival(page)

    check_and_solve_captcha(page)
    log(f"   🏪 [WAR] Arrived at {name} — buying items")
    war_buy_items_at_destination(page, cc)
    check_and_solve_captcha(page)

    # ── Travel home ───────────────────────────────────────────────────
    log("   🏠 [WAR] Travelling home...")
    try:
        home_btn = page.get_by_role("button", name="Travel home")
        home_btn.wait_for(timeout=8000)
        war_click(home_btn)
        war_jitter(150, 300)
        check_and_solve_captcha(page)

        travel_back = page.locator("//button[@class='torn-btn']")
        travel_back.wait_for(timeout=8000)
        war_click(travel_back)
        war_jitter(150, 300)
        check_and_solve_captcha(page)

        try:
            airstrip_home = page.get_by_role("link", name="Continue")
            airstrip_home.wait_for(timeout=4000)
            war_click(airstrip_home)
            log("   ✅ [WAR] Airstrip Continue (home leg)")
            war_jitter(100, 200)
        except Exception:
            pass

        log("   ✅ [WAR] Heading HOME!!")

    except Exception as e:
        log(f"   ⚠️ [WAR] Travel home error: {e} — retrying via travel page")
        try:
            page.goto("https://www.torn.com/page.php?sid=travel", wait_until="domcontentloaded")
            war_jitter(200, 400)
            check_and_solve_captcha(page)
            home_btn2 = page.get_by_role("button", name="Travel home")
            home_btn2.wait_for(timeout=8000)
            war_click(home_btn2)
            war_jitter(150, 300)
            check_and_solve_captcha(page)
            log("   ✅ [WAR] Travel home clicked (retry)")
        except Exception as e2:
            log(f"   ⚠️ [WAR] Travel home retry also failed: {e2}")

    wait_for_home(page)
    _settings["flight_destination"] = None
    _settings["flight_eta"] = None
    save_settings()
    log("✅ [WAR] Travel cycle complete!\n")


# ─────────────────────────────────────────────
# Energy — gym
# ─────────────────────────────────────────────

def gym(page):
    loc = detect_location(page)
    if loc != "home":
        log(f"🏋️ Skipping gym — currently {loc}, not at home")
        return

    log("🏋️ Energy threshold met — going to Gym")
    reading_pause()

    gym_link = page.locator('a:has-text("Gym")')
    gym_link.wait_for(timeout=5000)
    human_click(gym_link)
    check_and_solve_captcha(page)

    page.locator('xpath=//p[normalize-space()="What would you like to train today?"]').wait_for(timeout=5000)
    reading_pause(600, 1800)

    stats = {
        "strength":  page.locator("li[class='strength___UwX1Y'] span[class='propertyValue___wopyE']"),
        "speed":     page.locator("li[class='speed___qNMTy'] span[class='propertyValue___wopyE']"),
        "defense":   page.locator("li[class='defense___LITyA'] span[class='propertyValue___wopyE']"),
        "dexterity": page.locator("li[class='dexterity___6ayVQ'] span[class='propertyValue___wopyE']"),
    }
    stat_values = {}
    for name, locator in stats.items():
        locator.wait_for(timeout=5000)
        stat_values[name] = float(locator.inner_text().strip().replace(",", ""))

    log(f"   💪 Str:{stat_values['strength']} ⚡ Spd:{stat_values['speed']} "
        f"🛡 Def:{stat_values['defense']} 🎯 Dex:{stat_values['dexterity']}")

    normalized = {s: stat_values[s] / TARGET_RATIO[s] for s in stat_values}
    train_stat = min(normalized, key=normalized.get)
    log(f"   🏆 Training: {train_stat}")
    reading_pause(400, 1200)

    TRAIN_INPUTS = {
        "strength":  "//input[@aria-label='Enter the number of strength training']",
        "defense":   "//input[@aria-label='Enter the number of defense training']",
        "dexterity": "//input[@aria-label='Enter the number of dexterity training']",
        "speed":     "//input[@aria-label='Enter the number of speed training']",
    }

    try:
        inp = page.locator(f"xpath={TRAIN_INPUTS[train_stat]}")
        inp.wait_for(state="visible", timeout=5000)
        inp.fill(str(TRAIN_POINTS))
        log(f"   📝 Set {train_stat} input to {TRAIN_POINTS}")
        reading_pause(300, 800)
    except Exception as e:
        log(f"   ⚠️ Could not fill {train_stat} input ({e}) — training without count")

    train_button = page.locator(f"button[aria-label='Train {train_stat}']")
    train_button.wait_for(timeout=5000)
    human_click(train_button)
    log(f"   ✅ Trained {train_stat} x{TRAIN_POINTS}")
    human_pause(500, 1500)
    check_and_solve_captcha(page)
    log("   🏋️ Gym session complete — returning to main loop")



def get_drug_cooldown(page) -> bool:
    """
    Returns True if drug cooldown is active.
    Uses aria-label on the anchor — stable across CSS hash changes.
    """
    try:
        icon = page.locator("a[aria-label*='Drug Cooldown']")
        return icon.count() > 0
    except Exception:
        return False


def xanax_stack_action(page):
    """
    Consume one Xanax if:
    - xanax_stacking is ON
    - energy < xanax_target
    - no drug cooldown active
    - xanax in inventory
    """
    if not _settings.get("xanax_stacking"):
        return

    target = _settings.get("xanax_target", 1000)
    log(f"\n💊 Xanax Stack check (target={target}E)...")

    # ── Check current energy ──────────────────────────────────────────────
    try:
        energy = get_current_energy(page)
        if energy is None:
            log("   ⚠️ Could not read energy — skipping xanax check")
            return
        log(f"   ⚡ Energy: {energy}/{target}")
        if energy >= target:
            log(f"   🎯 Target {target}E reached — holding xanax")
            return
    except Exception as e:
        log(f"   ⚠️ Energy check error: {e}")
        return

    # ── Check drug cooldown ───────────────────────────────────────────────
    cooldown = get_drug_cooldown(page)
    if cooldown:
        log("   ⏳ Drug cooldown active — skipping xanax")
        return
    log("   ✅ No drug cooldown")

    # ── Go to item page ───────────────────────────────────────────────────
    try:
        log("   🌐 Navigating to item.php...")
        page.goto("https://www.torn.com/item.php", timeout=15000)
        page.wait_for_load_state("domcontentloaded", timeout=10000)
    except Exception as e:
        log(f"   ⚠️ Could not load item.php: {e}")
        return

    # ── Check xanax inventory ─────────────────────────────────────────────
    try:
        page.wait_for_load_state("domcontentloaded", timeout=10000)
        page.wait_for_timeout(1500)  # let items render

        # Use JS to find any element containing 'Xanax' in the item list
        qty = page.evaluate("""() => {
            const spans = document.querySelectorAll('span');
            for (const s of spans) {
                const t = s.innerText || '';
                if (t.match(/^Xanax(\\s+x\\d+)?$/)) return t;
            }
            return null;
        }""")

        if qty:
            log(f"   💊 Inventory: {qty}")
        else:
            log("   ❌ No Xanax in inventory!")
            _tg_send("⚠️ <b>Xanax Stack</b>: Out of Xanax! Stacking paused.")
            return
    except Exception as e:
        log(f"   ⚠️ Inventory check error: {e}")
        return

    # ── Click Take Xanax ──────────────────────────────────────────────────
    try:
        btn = page.get_by_role("button", name="Take Xanax")
        btn.wait_for(timeout=5000)
        btn.click()
        log("   🖱️ Clicked Take Xanax")

        # Confirm dialog
        yes = page.locator("a:has-text('Yes')")
        yes.wait_for(timeout=5000)
        yes.click()
        log("   🖱️ Clicked Yes")

        page.wait_for_timeout(1000)

        # Read new energy
        new_energy = get_current_energy(page)
        new_str = f"{new_energy}" if new_energy else "?"
        log(f"   ✅ Xanax consumed! Energy: {energy} → {new_str}")
        _tg_send(
            f"💊 <b>Xanax consumed!</b>\n"
            f"Energy: {energy} → {new_str} / {target}\n"
            f"Remaining: ~{max(0, target - (new_energy or energy)) // 250} more Xanax needed"
        )
    except Exception as e:
        log(f"   ⚠️ Failed to consume xanax: {e}")


def energy_action(page):
    log("   🎯 Energy action: GYM")
    gym(page)

# ─────────────────────────────────────────────
# TRAVEL — monitor flight countdown
# ─────────────────────────────────────────────

def egg_hunt_check(page) -> bool:
    """
    Navigate to the next page in EVERY_LINK, check for an egg and click it.
    Returns True if egg was found and clicked.
    Advances _egg_index and _egg_pages_seen regardless.
    """
    global _egg_index, _egg_pages_seen
    current_page = EVERY_LINK[_egg_index]
    url = "https://www.torn.com/" + current_page
    _egg_index      = (_egg_index + 1) % len(EVERY_LINK)
    _egg_pages_seen += 1

    try:
        log(f"   🥚 [{_egg_pages_seen} pages | {_egg_total} eggs total | session: {_egg_session}] → {current_page}")
        page.goto(url, wait_until="domcontentloaded", timeout=12000)
        check_and_solve_captcha(page)

        egg = page.locator("button[class*='eggAnim']").first
        try:
            egg.wait_for(state="visible", timeout=6000)
        except Exception:
            return False

        log(f"   🥚 EGG FOUND on {current_page} — clicking!")
        egg.click()
        time.sleep(1)
        save_egg_find(current_page)
        log(f"   ✅ Egg clicked! Total: {_egg_total} | Session: {_egg_session}")
        _tg_send(
            f"🥚 <b>EGG FOUND!</b>\n"
            f"Page    : {current_page}\n"
            f"Total   : {_egg_total} eggs\n"
            f"Session : {_egg_session} eggs"
        )
        return True

    except Exception as e:
        log(f"   ⚠️ Egg hunt error on {current_page}: {e}")
        return False


def egg_speed_hunt(page):
    """
    Pure egg speed hunt — visits every page in EVERY_LINK continuously,
    3 seconds between each. Runs until egg_speed_hunt is disabled via /settings.
    """
    global _egg_index, _egg_pages_seen
    log("🥚 Speed Hunt started — cycling all pages every 3s")

    while _settings.get("egg_speed_hunt"):
        current_page = EVERY_LINK[_egg_index]
        url = "https://www.torn.com/" + current_page
        _egg_index      = (_egg_index + 1) % len(EVERY_LINK)
        _egg_pages_seen += 1

        try:
            log(f"   🥚 [{_egg_pages_seen} pages | {_egg_total} total | session: {_egg_session}] → {current_page}")
            page.goto(url, wait_until="domcontentloaded", timeout=12000)
            check_and_solve_captcha(page)

            egg = page.locator("button[class*='eggAnim']").first
            try:
                egg.wait_for(state="visible", timeout=6000)
                log(f"   🥚 EGG FOUND on {current_page} — clicking!")
                egg.click()
                time.sleep(1)
                save_egg_find(current_page)
                log(f"   ✅ Egg clicked! Total: {_egg_total} | Session: {_egg_session}")
                _tg_send(
                    f"🥚 <b>EGG FOUND!</b>\n"
                    f"Page    : {current_page}\n"
                    f"Total   : {_egg_total} eggs\n"
                    f"Session : {_egg_session} eggs"
                )
            except Exception:
                pass   # no egg on this page

        except Exception as e:
            log(f"   ⚠️ Speed hunt error on {current_page}: {e}")

        time.sleep(3)

    log("🥚 Speed Hunt stopped")



def egg_hunt_flight_loop(page, flight_secs: int):
    """
    Runs during flight countdown — visits egg pages every 60s.
    Uses elapsed time to know when flight is done instead of reading DOM.
    """
    log(f"   🥚 Egg hunt flight mode — {flight_secs // 60}m flight, checking pages every 60s")
    flight_start = time.time()

    while True:
        elapsed = time.time() - flight_start
        remaining = flight_secs - elapsed

        if remaining <= 0:
            log("   🛬 Flight timer elapsed — landed!")
            return

        log(f"   ⏱ Flight: {int(remaining // 60)}m {int(remaining % 60)}s remaining")

        if remaining > 30:
            egg_hunt_check(page)
            # Sleep up to 60s but wake early if flight nearly done
            sleep_secs = min(60, remaining - 15)
            if sleep_secs > 0:
                time.sleep(sleep_secs)
        else:
            # Close to landing — just wait it out
            time.sleep(max(0, remaining - 5))



def wait_for_arrival(page):
    log("   ✈️  Monitoring flight countdown...")
    while True:
        try:
            secs = parse_travel_time(page)
            if secs is None:
                log("   🛬 Landed — time element disappeared")
                return
            if secs <= 0:
                log("   🛬 Countdown hit 0 — landed!")
                return

            if secs >= 60:
                log(f"   ⏱  {secs // 60}m {secs % 60}s remaining...")
            else:
                log(f"   ⏱  {secs}s remaining...")

            if secs > 60:
                delay = random.uniform(8.0, 12.0)
            elif secs > 30:
                delay = random.uniform(2.0, 4.0)
            elif secs > 10:
                delay = random.uniform(0.8, 1.5)
            else:
                delay = random.uniform(0.2, 0.6)

            time.sleep(delay)

        except Exception as e:
            log(f"   ⚠️ wait_for_arrival error: {e} — assuming landed")
            return


def wait_for_home(page):
    log("   🏠 Waiting to arrive home...")
    while True:
        try:
            secs = parse_travel_time(page)
            if secs is None or secs <= 0:
                break

            if secs >= 60:
                log(f"   ⏱  Returning home: {secs // 60}m {secs % 60}s...")
            else:
                log(f"   ⏱  Returning home: {secs}s remaining...")

            if secs > 60:
                delay = random.uniform(8.0, 12.0)
            elif secs > 30:
                delay = random.uniform(2.0, 4.0)
            elif secs > 10:
                delay = random.uniform(0.8, 1.5)
            else:
                delay = random.uniform(0.2, 0.6)

            time.sleep(delay)

        except Exception:
            break

    log("   🔄 Confirming home arrival...")
    try:
        page.locator("//a[@href='/crimes.php']").wait_for(state="visible", timeout=60000)
        log("   ✅ Home! Crimes link visible.")
    except Exception:
        log("   ⚠️ Crimes link timeout — assuming home anyway")


def recover_if_abroad(page) -> bool:
    """
    Called at top of each main loop cycle.
    Detects if player is abroad or traveling and handles recovery.
    Returns True if recovery was needed (travel only — hospital handled separately).
    """
    loc = detect_location(page)
    log(f"   📍 Location check: {loc}")
    check_and_solve_captcha(page)

    if loc == "hospital":
        log("   🏥 Hospitalized — skipping abroad recovery (handled separately)")
        return False

    if loc == "home":
        return False

    if loc == "traveling":
        dest_cc = get_travel_destination(page)
        if dest_cc == "home":
            log("   ✈️  In-flight returning home — waiting to land...")
            wait_for_home(page)
            return True
        elif dest_cc:
            log(f"   ✈️  In-flight to {FLIGHT_TIMES[dest_cc]['name']} — waiting for arrival...")
        else:
            log("   ✈️  In-flight (unknown destination) — waiting for arrival...")
        wait_for_arrival(page)
        check_and_solve_captcha(page)
        loc = detect_location(page)

    if loc == "abroad":
        log("   🌍 Abroad — buying items then returning home...")

        cc = get_travel_destination(page)
        if cc in ("home", None):
            cc = None
            title = page.title().lower()
            for code in COUNTRY_TRAVEL_SELECTORS:
                if FLIGHT_TIMES[code]["name"].lower() in title:
                    cc = code
                    break

        if cc and cc != "home":
            log(f"   🗺  Confirmed abroad at: {FLIGHT_TIMES[cc]['name']}")
            buy_items_at_destination(page, cc)
        else:
            log("   ⚠️ Could not detect country — trying all")
            for cc_try in COUNTRY_BUY_STEPS:
                if buy_items_at_destination(page, cc_try):
                    break

        check_and_solve_captcha(page)

        log("   🏠 Recovery: travelling home...")
        try:
            home_btn = page.get_by_role("button", name="Travel home")
            home_btn.wait_for(timeout=8000)
            home_btn.click()
            reading_pause(800, 1500)
            check_and_solve_captcha(page)
            travel_back = page.locator("//button[@class='torn-btn']")
            travel_back.wait_for(timeout=8000)
            travel_back.click()
            reading_pause(800, 1500)
            check_and_solve_captcha(page)

            try:
                airstrip_home = page.get_by_role("link", name="Continue")
                check_and_solve_captcha(page)
                airstrip_home.wait_for(timeout=4000)
                airstrip_home.click()
                log("   ✅ Airstrip Continue (recovery)")
            except Exception:
                pass

            wait_for_home(page)
            log("   ✅ Recovery complete!")

        except Exception as e:
            log(f"   ⚠️ Recovery travel home failed: {e}")
            for _ in range(30):
                time.sleep(60)
                page.reload(wait_until="domcontentloaded")
                check_and_solve_captcha(page)
                if is_home(page):
                    log("   ✅ Now home after waiting")
                    break

    return True


def _extract_form_id(buy_selector: str) -> str | None:
    """Extracts form id value from a buy button selector like [form='item-258-form']."""
    import re as _re
    m = _re.search(r"\[form=['\"](item-\d+-form)['\"]]", buy_selector)
    return m.group(1) if m else None


def buy_items_at_destination(page, cc: str) -> bool:
    """
    Buys ALL available items in ITEM_PRIORITY order for the given country.
    Sequence per item: JS-click MAX span -> click buy button -> confirm Yes dialog.
    """
    steps = COUNTRY_BUY_STEPS.get(cc, [])
    steps_ordered = sorted(
        steps,
        key=lambda s: ITEM_PRIORITY.index(s["name"]) if s["name"] in ITEM_PRIORITY else 99
    )

    bought_any = False

    for step in steps_ordered:
        name = step["name"]
        log(f"   🛍  Buying: {name}")
        try:
            # ── Step 1: Click MAX span to fill qty ────────────────────────────
            max_loc = page.locator(step["max_selector"]).first
            max_loc.wait_for(state="attached", timeout=6000)
            page.evaluate("el => el.click()", max_loc.element_handle())
            time.sleep(1)

            # ── Step 2: Click buyIconButton ───────────────────────────────────
            buy_loc = page.locator(step["buy_selector"]).first
            buy_loc.wait_for(state="attached", timeout=6000)
            page.evaluate("el => el.click()", buy_loc.element_handle())
            time.sleep(1)

            # ── Step 3: Confirm dialog ────────────────────────────────────────
            confirm_loc = page.locator(step["confirm_selector"]).first
            confirm_loc.wait_for(state="visible", timeout=6000)
            human_click(confirm_loc)
            time.sleep(1)

            log(f"   ✅ Bought: {name}")
            bought_any = True

        except Exception as e:
            log(f"   ⚠️ Could not buy {name}: {e} — skipping")

    if not bought_any:
        log("   ❌ No items in stock — heading home")

    return bought_any


def travel_action(page):
    """Full travel loop. Only runs if confirmed at home."""
    loc = detect_location(page)
    if loc != "home":
        log(f"   ✈️  Skipping travel — currently {loc}, not at home")
        return

    log("\n✈️  Starting travel action...")

    cc = pick_best_destination()
    if cc is None:
        log("   ⏸ No viable destination — skipping travel this cycle")
        return
    sel  = COUNTRY_TRAVEL_SELECTORS[cc]
    name = FLIGHT_TIMES[cc]["name"]

    # ── Cash check ─────────────────────────────────────────────────────────
    try:
        cash_el   = page.locator("//span[@id='user-money']")
        cash_el.wait_for(timeout=3000)
        cash      = int(cash_el.get_attribute("data-money") or 0)
        _settings["last_cash"] = cash
        save_settings()
        buy_price = int(_last_run_info.get("buyPrice", 0))
        run_cost  = buy_price * 29

        if run_cost > 0:
            if _settings.get("fly_low_cash"):
                # Fly regardless — low cash override active
                log(f"   ⚠️ Low cash override ON | Cash: {cash:,} | Need: {run_cost:,}")
            elif cash >= run_cost:
                after = cash - run_cost
                log(f"   💵 Cash: {cash:,} ✅ | Cost: {run_cost:,} | After: {after:,}")
                _tg_send(f"💰 Your cash is enough for this important travel boss!\n"
                         f"💵 Cash: {cash:,} | Cost: {run_cost:,} | After: {after:,}")
            else:
                short = run_cost - cash
                log(f"   ⚠️ INSUFFICIENT CASH! Have: {cash:,} | Need: {run_cost:,} | Short: {short:,}")
                # Try re-evaluating — maybe a cheaper destination fits
                cc_new = pick_best_destination()
                if cc_new:
                    new_cost = int(_last_run_info.get("buyPrice", 0)) * 29
                    if new_cost == 0 or cash >= new_cost:
                        log(f"   🔄 Switching to cheaper destination: {FLIGHT_TIMES.get(cc_new,{}).get('name',cc_new)}")
                        cc   = cc_new
                        sel  = COUNTRY_TRAVEL_SELECTORS[cc]
                        name = FLIGHT_TIMES[cc]["name"]
                    else:
                        _tg_send(f"⚠️ <b>INSUFFICIENT CASH!</b>\n"
                                 f"Have : {cash:,}\n"
                                 f"Need : {run_cost:,}\n"
                                 f"Short: {short:,}\n"
                                 f"Use /resumeflight to force fly or add cash.")
                        log("   ⏸ Skipping travel — insufficient cash. Gym/crimes continue.")
                        return
                else:
                    return
        else:
            log(f"   💵 Cash: {cash:,} (no cost data)")
    except Exception as e:
        log(f"   ⚠️ Could not read cash: {e}")

    # ── Nerve check — do crimes first if nerve ready ───────────────────────
    try:
        nerve_now = get_current_nerve(page)
        trigger   = _nerve_trigger_now or 0
        if nerve_now is not None and nerve_now >= trigger and trigger > 0:
            log(f"   🧠 Nerve {nerve_now} >= {trigger} — doing crimes before flight")
            nerve_action(page)
            log("   🔄 Re-evaluating destination after crimes...")
            cc = pick_best_destination()
            if cc is None:
                log("   ⏸ No viable destination after nerve — skipping travel")
                return
            sel  = COUNTRY_TRAVEL_SELECTORS[cc]
            name = FLIGHT_TIMES[cc]["name"]
        else:
            log(f"   🧠 Nerve {nerve_now}/{trigger} — no action needed")
    except Exception as e:
        log(f"   ⚠️ Nerve check failed: {e}")

    reading_pause(1000, 2500)
    page.goto("https://www.torn.com/page.php?sid=travel", wait_until="domcontentloaded")
    reading_pause(1000, 2000)
    check_and_solve_captcha(page)

    log(f"   🗺  Selecting: {name}")
    radio = page.locator(sel["map_label"])
    radio.wait_for(timeout=8000)
    human_click(radio)
    reading_pause(500, 1200)

    travel_btn = page.get_by_role("button", name=sel["button"])
    travel_btn.wait_for(timeout=5000)
    human_click(travel_btn)
    log(f"   ✅ Clicked '{sel['button']}'")
    reading_pause(800, 1500)

    continue_btn = page.get_by_role("button", name="Continue")
    continue_btn.wait_for(timeout=8000)
    human_click(continue_btn)
    log("   ✅ Clicked Continue (dialog)")
    reading_pause(800, 1500)

    # ── Dirty bomb / terror attack block — airspace closed ───────────────────
    block_msg = page.locator(".responseMessage___w0GSG")
    if block_msg.count() > 0:
        try:
            msg_text = block_msg.first.inner_text(timeout=2000).strip().lower()
        except Exception:
            msg_text = ""
        block_keywords = ["closed", "cannot", "blocked", "unavailable", "attack", "bomb"]
        if any(kw in msg_text for kw in block_keywords):
            log(f"   🚫 Travel blocked: '{msg_text}' — skipping travel this cycle")
            return

    # ── Airstrip — proceed to flight ─────────────────────────────────────────
    try:
        airstrip_btn = page.get_by_role("link", name="Continue")
        airstrip_btn.wait_for(timeout=8000)
        human_click(airstrip_btn)
        log("   ✅ Clicked Airstrip Continue — now flying!")
        _settings["flight_destination"] = name
        _settings["flight_eta"] = int(time.time()) + FLIGHT_TIMES[cc]["seconds"]
        save_settings()
    except Exception as e:
        log(f"   🚫 Airstrip Continue not found ({e}) — travel blocked, skipping")
        return   # keep looping energy/nerve, no wipe

    check_and_solve_captcha(page)
    wait_for_arrival(page)

    log("   🔒 Checking for captcha on landing...")
    check_and_solve_captcha(page)

    log(f"   🏪 Arrived at {name} — buying items NOW")
    buy_items_at_destination(page, cc)
    check_and_solve_captcha(page)

    # ── Travel home ───────────────────────────────────────────────────────────
    log("   🏠 Clicking Travel home...")
    try:
        home_btn = page.get_by_role("button", name="Travel home")
        home_btn.wait_for(timeout=8000)
        human_click(home_btn)
        reading_pause(800, 1500)
        check_and_solve_captcha(page)
        travel_back = page.locator("//button[@class='torn-btn']")
        travel_back.wait_for(timeout=8000)
        human_click(travel_back)
        reading_pause(800, 1500)
        check_and_solve_captcha(page)

        try:
            airstrip_home = page.get_by_role("link", name="Continue")
            airstrip_home.wait_for(timeout=4000)
            human_click(airstrip_home)
            log("   ✅ Airstrip Continue (home leg)")
            reading_pause(500, 1000)
        except Exception:
            pass

        log("   ✅ Heading HOME!!")

    except Exception as e:
        log(f"   ⚠️ Travel home error: {e} — retrying via travel page")
        try:
            page.goto("https://www.torn.com/page.php?sid=travel", wait_until="domcontentloaded")
            reading_pause(1000, 2000)
            check_and_solve_captcha(page)
            home_btn2 = page.get_by_role("button", name="Travel home")
            home_btn2.wait_for(timeout=8000)
            home_btn2.click()
            reading_pause(800, 1500)
            check_and_solve_captcha(page)
            log("   ✅ Travel home clicked (retry)")
        except Exception as e2:
            log(f"   ⚠️ Travel home retry also failed: {e2}")

    wait_for_home(page)
    _settings["flight_destination"] = None
    _settings["flight_eta"] = None
    save_settings()
    log("✅ Travel cycle complete!\n")

# ─────────────────────────────────────────────
# Gmail OTP fetcher
# ─────────────────────────────────────────────

def fetch_torn_otp(max_wait: int = OTP_POLL_TIMEOUT) -> str | None:
    """
    Polls Gmail via IMAP for a Torn City OTP email and extracts the code.
    Relies on the UNSEEN flag to avoid reusing old codes — each email is
    marked Seen immediately after a valid OTP is extracted.

    Returns the 6-digit code string, or None on timeout/failure.
    """
    import time as _time

    log(f"   📬 Polling Gmail for Torn OTP (up to {max_wait}s)...")
    deadline = _time.time() + max_wait

    while _time.time() < deadline:
        try:
            with imaplib.IMAP4_SSL("imap.gmail.com") as imap:
                imap.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
                imap.select("INBOX")

                # Search unseen Torn auth emails
                status, data = imap.search(None,
                    '(UNSEEN FROM "torn.com" SUBJECT "authorization")'
                )
                if status != "OK" or not data[0]:
                    # Broader fallback — any unseen Torn mail
                    status, data = imap.search(None,
                        '(UNSEEN FROM "noreply@torn.com")'
                    )

                ids = data[0].split() if data[0] else []
                for msg_id in reversed(ids):   # newest first
                    _, msg_data = imap.fetch(msg_id, "(RFC822)")
                    raw = msg_data[0][1]
                    msg = emaillib.message_from_bytes(raw)

                    # Extract plain-text body
                    body = ""
                    if msg.is_multipart():
                        for part in msg.walk():
                            if part.get_content_type() == "text/plain":
                                body += part.get_payload(decode=True).decode("utf-8", errors="replace")
                    else:
                        body = msg.get_payload(decode=True).decode("utf-8", errors="replace")

                    # Extract 6-digit OTP — Torn format: "T-744821"
                    match = re.search(r"T-?(\d{6})", body)
                    if not match:
                        match = re.search(r"\b(\d{6})\b", body)  # generic fallback
                    if match:
                        code = match.group(1)
                        log(f"   ✅ OTP found: {code}")
                        # Mark as seen so we don't reuse it
                        imap.store(msg_id, "+FLAGS", "\\Seen")
                        return code
                    log(f"   ⚠️ Torn email found but no 6-digit code in body")

        except Exception as e:
            log(f"   ⚠️ Gmail IMAP error: {e}")

        remaining = int(deadline - _time.time())
        log(f"   ⏳ No OTP yet — retrying... ({remaining}s left)")
        _time.sleep(OTP_POLL_INTERVAL)

    log("   ❌ OTP fetch timed out")
    return None


def handle_otp_page(page) -> bool:
    """
    Detects Torn's OTP page and fills the code automatically from Gmail.

    Selectors:
      - Input:  #verify-code-input
      - Submit: #verify-code-form .btn-wrap.submit button
      - Timer:  span.otp-timeleft.hasCountdown  (inner text = seconds remaining)
      - Resend: a.resend  (has class "disabled" while timer active)

    Flow: poll Gmail → no email → wait timer → click resend → repeat (999x).
    On total failure raises RuntimeError — caught by the main loop's global
    error counter which triggers wipe + full restart after 2 hits.
    """
    MAX_RESEND_ATTEMPTS = 999

    def _read_timer_secs() -> int:
        try:
            el = page.locator("span.otp-timeleft.hasCountdown")
            if el.count() > 0:
                raw = el.first.inner_text(timeout=1000).strip()
                if raw.isdigit():
                    return int(raw)
                exp = el.first.get_attribute("data-time-exp")
                if exp and exp.isdigit():
                    return int(exp)
        except Exception:
            pass
        return 0

    def _click_resend():
        secs = _read_timer_secs()
        if secs > 0:
            log(f"   ⏳ Resend timer: {secs}s — waiting...")
            for _ in range(secs + 5):
                time.sleep(1)
                remaining = _read_timer_secs()
                if remaining == 0:
                    break
                log(f"   ⏳ {remaining}s remaining...")
        try:
            resend = page.locator("a.resend")
            resend.wait_for(state="visible", timeout=5000)
            for _ in range(10):
                cls = resend.get_attribute("class") or ""
                if "disabled" not in cls:
                    break
                time.sleep(1)
            human_click(resend)
            log("   🔁 Resend clicked")
            reading_pause(1500, 2500)
        except Exception as e:
            log(f"   ⚠️ Resend click error: {e}")

    # ── Detect OTP page ───────────────────────────────────────────────────────
    is_otp_url = "authenticate.php" in page.url
    otp_input  = page.locator("#verify-code-input")
    if not is_otp_url and otp_input.count() == 0:
        return False   # not an OTP page

    log("   🔑 OTP page detected — fetching code from Gmail...")

    code = None
    for attempt in range(1, MAX_RESEND_ATTEMPTS + 1):
        log(f"   📬 OTP attempt {attempt}")
        code = fetch_torn_otp()
        if code:
            break
        log(f"   ⚠️ No OTP received — requesting resend (attempt {attempt})...")
        _click_resend()

    if not code:
        raise RuntimeError("OTP: exhausted all resend attempts — no code received")

    otp_input.wait_for(state="visible", timeout=8000)
    human_fill(otp_input, code)
    reading_pause(500, 1000)

    try:
        submit = page.locator("#verify-code-form .btn-wrap.submit button").first
        submit.wait_for(state="visible", timeout=3000)
        human_click(submit)
    except Exception:
        otp_input.press("Enter")

    reading_pause(1500, 2500)
    log("   ✅ OTP submitted")
    return True


# ─────────────────────────────────────────────
# Browser helpers
# ─────────────────────────────────────────────

def is_port_open(host: str, port: int, timeout: float = 0.3) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def wait_for_connectivity(page, url: str = PAGE_URL, max_wait: int = 60) -> bool:
    """
    Waits until page.goto(url) succeeds (no DNS/network error).
    CF managed challenges temporarily block DNS — this waits them out.
    Returns True once the page loads, False on timeout.
    """
    log(f"   🌐 Waiting for network connectivity (up to {max_wait}s)...")
    deadline = time.time() + max_wait
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=15000)
            if "torn.com" in page.url and not _is_cf_managed_challenge(page):
                log(f"   🌐 Connected after {attempt} attempt(s)")
                return True
        except Exception:
            pass
        time.sleep(3)
    log("   ❌ Could not reach torn.com within connectivity wait window")
    return False


def ensure_brave_cdp():
    if is_port_open("127.0.0.1", DEBUG_PORT):
        log(f"🟢 CDP port {DEBUG_PORT} already open.")
        return
    # Wipe profile before every fresh launch so CF always sees a clean fingerprint
    # log("🧹 Wiping browser profile before launch...")
    _wipe_cdp_profile()
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    subprocess.Popen(
        [BRAVE_PATH,
         f"--remote-debugging-port={DEBUG_PORT}",
         f"--user-data-dir={USER_DATA_DIR}",
         "--no-first-run",
         "--no-default-browser-check",
         "--disable-features=TranslateUI",
         ],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    log("🚀 Launched Brave with CDP.")
    deadline = time.time() + 10
    while time.time() < deadline:
        if is_port_open("127.0.0.1", DEBUG_PORT):
            log("🟢 CDP ready.")
            return
        time.sleep(0.2)
    raise RuntimeError("CDP port did not open within 10s.")


def _kill_brave():
    """Force-kills all Brave browser processes."""
    try:
        subprocess.run(
            ["taskkill", "/F", "/IM", "brave.exe"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        log("   🔴 Brave processes killed")
        time.sleep(2)
    except Exception as e:
        log(f"   ⚠️ Kill Brave error: {e}")


def _wipe_cdp_profile():
    """
    Deletes all contents of USER_DATA_DIR to clear Brave's fingerprint cache,
    cookies, localStorage, IndexedDB and all browser state.

    This gives Cloudflare a brand-new browser identity on next launch —
    the most effective fix for persistent managed challenges that won't auto-pass.

    WARNING: Wipes the login session. Bot must re-login to torn.com after this.
    """
    import shutil
    if not os.path.exists(USER_DATA_DIR):
        log(f"   ⚠️ Profile dir not found: {USER_DATA_DIR}")
        return
    try:
        for entry in os.listdir(USER_DATA_DIR):
            entry_path = os.path.join(USER_DATA_DIR, entry)
            try:
                if os.path.isdir(entry_path):
                    shutil.rmtree(entry_path)
                else:
                    os.remove(entry_path)
            except Exception as e:
                log(f"   ⚠️ Could not delete {entry_path}: {e}")
        log(f"   🧹 Profile wiped: {USER_DATA_DIR}")
    except Exception as e:
        log(f"   ⚠️ Wipe error: {e}")


def fresh_browser_restart(wipe_profile: bool = True) -> bool:
    """
    Kills Brave, optionally wipes the automation profile (removes cached fingerprint),
    then relaunches Brave with CDP.

    Why this works against managed challenges:
        Cloudflare scores the browser fingerprint — cookies, canvas hash, WebGL,
        fonts, installed extensions, visit history, etc. A wiped profile gets a
        completely fresh identity that CF hasn't flagged yet, so the 45s auto-wait
        in _try_solve_managed_challenge() succeeds on the next attempt.

    Args:
        wipe_profile: True  = delete USER_DATA_DIR contents (new fingerprint, loses login).
                      False = just restart without wiping (keeps cookies/login session).

    Returns:
        True if CDP port came back up successfully, False on timeout.

    IMPORTANT: After calling this, the caller MUST reconnect Playwright:
        context = p.chromium.launch_persistent_context(USER_DATA_DIR, headless=False, ...)
        page    = context.new_page()
    """
    log("\n♻️  Fresh browser restart...")

    _kill_brave()

    if wipe_profile:
        log("   🧹 Wiping profile for fresh CF fingerprint...")
        _wipe_cdp_profile()
    else:
        log("   ℹ️  Keeping profile (wipe_profile=False)")

    os.makedirs(USER_DATA_DIR, exist_ok=True)
    log("   🚀 Relaunching Brave with CDP...")
    subprocess.Popen(
        [BRAVE_PATH,
         f"--remote-debugging-port={DEBUG_PORT}",
         f"--user-data-dir={USER_DATA_DIR}",
         "--no-first-run",
         "--no-default-browser-check",
         "--disable-features=TranslateUI",
         ],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    deadline = time.time() + 15
    while time.time() < deadline:
        if is_port_open("127.0.0.1", DEBUG_PORT):
            log("   🟢 CDP port open — browser ready")
            time.sleep(1)
            return True
        time.sleep(0.3)

    log("   ❌ CDP port did not open within 15s")
    return False


# ─────────────────────────────────────────────
# Telegram bot
# ─────────────────────────────────────────────

def _tg_send(text: str):
    """Send a message to the owner chat. Fire-and-forget, never raises."""
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
    except Exception as e:
        log(f"   ⚠️ Telegram send error: {e}")


def _tg_tail_log(lines: int = 30) -> str:
    """Return the last N lines of the current log file."""
    try:
        with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
        return "".join(all_lines[-lines:]).strip()
    except Exception as e:
        return f"(log read error: {e})"


def _tg_status_text() -> str:
    """Build the /status reply string — full dashboard."""
    state = "⏸ PAUSED" if _bot_paused.is_set() else "▶️ RUNNING"
    icons = {True: "✅", False: "❌"}

    # ── Cash ───────────────────────────────────────────────────────────────
    cash = _settings.get("last_cash", 0)
    cash_str = f"{cash:,}" if cash else "unknown"

    # ── Flight status ───────────────────────────────────────────────────────
    dest = _settings.get("flight_destination")
    eta  = _settings.get("flight_eta")
    if dest and eta:
        remaining = int(eta - time.time())
        if remaining > 0:
            h, m = divmod(remaining // 60, 60)
            eta_str  = datetime.fromtimestamp(eta).strftime("%H:%M")
            rem_str  = f"{h}h {m}m" if h else f"{m}m"
            flight_str = f"✈️ In flight → {dest}\n  Remaining : {rem_str} (ETA {eta_str})"
        else:
            flight_str = f"🛬 Landed at {dest}"
    else:
        flight_str = "🏠 At home"

    # ── Toggles ────────────────────────────────────────────────────────────
    toggles = (
        f"  Flight {icons[_settings['flight']]}  "
        f"Energy {icons[_settings['energy']]}  "
        f"Nerve {icons[_settings['nerve']]}  "
        f"War {icons[_settings['war_mode']]}  "
        f"🥚 {icons[_settings['egg_speed_hunt']]}  "
        f"💊 {icons[_settings.get('xanax_stacking', False)]}  "
        f"💸 {icons[_settings.get('fly_low_cash', False)]}"
    )

    # ── Config ─────────────────────────────────────────────────────────────
    config = (
        f"  Energy      : {_settings['energy_min']}–{_settings['energy_max']}\n"
        f"  Train pts   : {_settings['train_points']} reps\n"
        f"  Nerve trig  : {_nerve_trigger_now or '?'}\n"
        f"  Confidence  : {_settings.get('predict_confidence', 0.5)}\n"
        f"  Stock buffer: {_settings.get('stock_buffer', -5)}m\n"
        f"  Def window  : {RESTOCK_WINDOW_EARLY} to +{RESTOCK_WINDOW_LATE}"
    )

    # ── Priorities ─────────────────────────────────────────────────────────
    if PRIORITY_TARGETS:
        pri_lines = []
        for i, (cc, item) in enumerate(PRIORITY_TARGETS, 1):
            country = FLIGHT_TIMES.get(cc, {}).get("name", cc)
            win = ITEM_RESTOCK_WINDOWS.get(item)
            win_str = f" [{win[0]},+{win[1]}]" if win else ""
            pri_lines.append(f"  {i}. {item} ({country}){win_str}")
        pri_str = "\n".join(pri_lines)
    else:
        pri_str = "  (none set)"

    # ── Fillers ────────────────────────────────────────────────────────────
    filler_str = " > ".join(FLIGHT_TIMES.get(cc, {}).get("name", cc) for cc in FILLER_PRIORITY)

    # ── Last run ───────────────────────────────────────────────────────────
    if _last_run_info:
        buy_price  = int(_last_run_info.get("buyPrice", 0))
        run_cost   = buy_price * 29
        run_profit = int(_last_run_info.get("profitPerItem", 0) * 29)
        run_ppm    = int(_last_run_info.get("profitPerMinute", 0))
        run_margin = _last_run_info.get("marginMinutes")
        run_state  = _last_run_info.get("availabilityState", "?")
        run_tight  = "⚠️ TIGHT" if _last_run_info.get("timingTight") else "✅"
        margin_str = f"{run_margin}m" if run_margin is not None else "in stock"
        last_run_str = (
            f"  {_last_run_info.get('itemName','?')} ({_last_run_info.get('country','?')})\n"
            f"  Cost   : {run_cost:,}\n"
            f"  Profit : {run_profit:,}\n"
            f"  PPM    : {run_ppm:,}/min\n"
            f"  State  : {margin_str} {run_tight}"
        )
    else:
        last_run_str = "  (no run yet)"

    lines = [
        f"<b>🤖 Torn Bot</b> — {state}",
        f"",
        f"💰 Cash: {cash_str}",
        f"{flight_str}",
        f"",
        f"<b>⚙️ Toggles:</b>",
        toggles,
        f"",
        f"<b>📊 Config:</b>",
        config,
        f"",
        f"<b>🎯 Priorities:</b>",
        pri_str,
        f"<b>🔄 Fillers:</b> {filler_str}",
        f"",
        f"<b>💰 Last run:</b>",
        last_run_str,
    ]

    if _settings.get("egg_speed_hunt"):
        lines += [
            f"",
            f"<b>🥚 Egg Hunt:</b>",
            f"  Pages: {_egg_pages_seen} | Total: {_egg_total} | Session: {_egg_session}",
            f"  Index: {_egg_index}/{len(EVERY_LINK)} ({EVERY_LINK[_egg_index] if _egg_index < len(EVERY_LINK) else '?'})",
        ]

    if _settings.get("xanax_stacking"):
        lines += [
            f"",
            f"<b>💊 Xanax Stacking:</b>",
            f"  Target  : {_settings.get('xanax_target', 1000)}E",
            f"  Energy  : locked OFF (gym disabled)",
        ]

    lines += [
        f"",
        f"<b>📋 Last 10 log lines:</b>",
        f"<pre>{_tg_tail_log(10)}</pre>",
    ]
    return "\n".join(lines)


def _tg_settings_keyboard() -> dict:
    """Build inline keyboard for /settings command."""
    icons = {True: "✅", False: "❌"}
    rows = [
        [
            {"text": f"{icons[_settings['flight']]} Flight",                "callback_data": "set:flight"},
            {"text": f"{icons[_settings['energy']]} Energy",                "callback_data": "set:energy"},
        ],
        [
            {"text": f"{icons[_settings['nerve']]} Nerve",                  "callback_data": "set:nerve"},
            {"text": f"{icons[_settings['war_mode']]} War Mode",            "callback_data": "set:war_mode"},
        ],
        [
            {"text": f"{icons[_settings['egg_speed_hunt']]} 🥚 Speed Hunt", "callback_data": "set:egg_speed_hunt"},
            {"text": f"{icons[_settings.get('xanax_stacking',False)]} 💊 Xanax Stack", "callback_data": "set:xanax_stacking"},
        ],
        [{"text": "✅ Done", "callback_data": "set:done"}],
    ]
    return {"inline_keyboard": rows}


def _tg_priority_keyboard() -> dict:
    """Build the inline keyboard for /priority command."""
    active_set = set(PRIORITY_TARGETS)
    rows = []
    row  = []
    for i, (cc, item) in enumerate(ALL_POSSIBLE_TARGETS):
        country = FLIGHT_TIMES.get(cc, {}).get("name", cc)
        label   = f"{'✅' if (cc, item) in active_set else '☐'} {item[:16]} ({country[:3]})"
        # callback_data max 64 bytes — use compact format
        cb_data = f"pri:{cc}:{item}"[:64]
        row.append({"text": label, "callback_data": cb_data})
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    # Footer row
    rows.append([{"text": "✅ Done", "callback_data": "pri:done"}])
    return {"inline_keyboard": rows}


def _tg_send_inline(text: str, keyboard: dict) -> int | None:
    """Send a message with inline keyboard. Returns message_id or None."""
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json={
                "chat_id":      TELEGRAM_CHAT_ID,
                "text":         text,
                "parse_mode":   "HTML",
                "reply_markup": keyboard,
            },
            timeout=10,
        )
        data = r.json()
        return data.get("result", {}).get("message_id")
    except Exception as e:
        log(f"   ⚠️ Telegram inline send error: {e}")
        return None


def _tg_edit_keyboard(message_id: int, keyboard: dict):
    """Update the inline keyboard on an existing message."""
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/editMessageReplyMarkup",
            json={
                "chat_id":      TELEGRAM_CHAT_ID,
                "message_id":   message_id,
                "reply_markup": keyboard,
            },
            timeout=10,
        )
    except Exception as e:
        log(f"   ⚠️ Telegram edit keyboard error: {e}")


def _tg_answer_callback(callback_query_id: str, text: str = ""):
    """Acknowledge a callback query (removes loading spinner)."""
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/answerCallbackQuery",
            json={"callback_query_id": callback_query_id, "text": text},
            timeout=10,
        )
    except Exception as e:
        log(f"   ⚠️ Telegram answer callback error: {e}")


def _tg_run_predict(cc: str, item_name: str, country_name: str):
    """Run predict API and send result to Telegram."""
    pred = _call_predict_api(cc, item_name)
    if not pred:
        _tg_send(f"⚠️ Could not reach predict API for {item_name} ({cc})")
        return

    a           = pred.get("analysis", {})
    fly         = pred.get("fly")
    fly_icon    = "✅ FLY" if fly else ("❌ SKIP" if fly is False else "❓ NO DATA")
    conf        = pred.get("confidence", 0)
    # restockEta comes from predict API — tracker value or DroqsDB fallback from Firebase
    restock_eta = pred.get("restockEta")
    restock_str = f"{restock_eta}m" if restock_eta is not None else "?"
    _tg_send(
        f"<b>🔮 Predict: {item_name} ({country_name})</b>\n"
        f"Decision    : {fly_icon}\n"
        f"Reason      : {pred.get('reason','?')}\n"
        f"Confidence  : {conf}\n"
        f"Next window : {str(pred.get('nextWindowMins'))+'m' if pred.get('nextWindowMins') is not None else '?'}\n"
        f"\n<b>Analysis:</b>\n"
        f"  Stock now   : {a.get('currentStock','?')}\n"
        f"  Runway      : {str(a.get('stockRunway'))+'m' if a.get('stockRunway') is not None else '?'}\n"
        f"  Depletion   : {a.get('depletionRate','?')} units/min\n"
        f"  Stock lasts : {str(a.get('avgStockDuration'))+'m' if a.get('avgStockDuration') is not None else '?'} after restock\n"
        f"  Restock ETA : {restock_str}\n"
        f"  Interval    : {str(a.get('avgRestockInterval'))+'m' if a.get('avgRestockInterval') is not None else '?'} avg\n"
        f"  Data pts    : {a.get('dataPoints','?')}\n"
        f"  Restocks    : {a.get('restockCount','?')} observed"
    )
    log(f"📲 Telegram: predict {cc} {item_name} → fly={fly} conf={conf}")


def _tg_handle(update: dict):
    """Dispatch a single Telegram update to the right command."""
    global ENERGY_MIN, ENERGY_MAX, _bot_started, WAR_MODE, _energy_threshold_now
    global PRIORITY_TARGETS, ITEM_PRIORITY, DEFAULT_COUNTRY

    # ── Handle inline keyboard button presses ─────────────────────────────
    cb = update.get("callback_query")
    if cb:
        cb_id   = cb.get("id", "")
        cb_data = cb.get("data", "")
        msg     = cb.get("message", {})
        msg_id  = msg.get("message_id")

        if cb_data.startswith("pred_cc:"):
            cc      = cb_data.split(":")[1]
            country = FLIGHT_TIMES.get(cc, {}).get("name", cc)
            items   = [item for c, item in ALL_POSSIBLE_TARGETS if c == cc]
            rows = []
            row  = []
            for item in items:
                row.append({"text": item, "callback_data": f"pred_item:{cc}:{item}"})
                if len(row) == 2:
                    rows.append(row)
                    row = []
            if row:
                rows.append(row)
            rows.append([{"text": "◀️ Back", "callback_data": "pred_back"}])
            _tg_answer_callback(cb_id)
            if msg_id:
                try:
                    requests.post(
                        f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/editMessageText",
                        json={"chat_id": TELEGRAM_CHAT_ID, "message_id": msg_id,
                              "text": f"🔮 <b>Predict — {country}. Select item:</b>",
                              "parse_mode": "HTML", "reply_markup": {"inline_keyboard": rows}},
                        timeout=10,
                    )
                except Exception:
                    _tg_send_inline(f"🔮 <b>Predict — {country}. Select item:</b>", {"inline_keyboard": rows})
            return

        if cb_data.startswith("pred_item:"):
            parts   = cb_data.split(":", 2)
            cc      = parts[1]
            item_name = parts[2]
            country = FLIGHT_TIMES.get(cc, {}).get("name", cc)
            _tg_answer_callback(cb_id, f"Checking {item_name}...")
            _tg_run_predict(cc, item_name, country)
            return

        if cb_data == "pred_back":
            _tg_answer_callback(cb_id)
            CC_LABELS = [
                ("mex", "🇲🇽 Mexico"),     ("cay", "🏝 Cayman"),      ("can", "🇨🇦 Canada"),
                ("haw", "🌺 Hawaii"),      ("uni", "🇬🇧 UK"),          ("arg", "🇦🇷 Argentina"),
                ("swi", "🇨🇭 Switzerland"),("jap", "🇯🇵 Japan"),      ("chi", "🇨🇳 China"),
                ("uae", "🇦🇪 UAE"),        ("sou", "🇿🇦 S.Africa"),
            ]
            rows = []
            row  = []
            for cc, label in CC_LABELS:
                row.append({"text": label, "callback_data": f"pred_cc:{cc}"})
                if len(row) == 3:
                    rows.append(row)
                    row = []
            if row:
                rows.append(row)
            if msg_id:
                try:
                    requests.post(
                        f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/editMessageText",
                        json={"chat_id": TELEGRAM_CHAT_ID, "message_id": msg_id,
                              "text": "🔮 <b>Predict — Select country:</b>",
                              "parse_mode": "HTML", "reply_markup": {"inline_keyboard": rows}},
                        timeout=10,
                    )
                except Exception:
                    pass
            return

        if cb_data == "pred_cancel":
            _tg_answer_callback(cb_id, "Cancelled")
            return

        if cb_data.startswith("set:"):
            key = cb_data[4:]
            if key == "done":
                _tg_answer_callback(cb_id, "✅ Settings saved!")
                _tg_send(
                    f"<b>✅ Settings saved</b>\n"
                    f"Flight    : {'✅' if _settings['flight'] else '❌'}\n"
                    f"Energy    : {'✅' if _settings['energy'] else '❌'}\n"
                    f"Nerve     : {'✅' if _settings['nerve'] else '❌'}\n"
                    f"War Mode  : {'✅' if _settings['war_mode'] else '❌'}\n"
                    f"🥚 Speed  : {'✅' if _settings['egg_speed_hunt'] else '❌'}\n"
                        f"💊 Xanax  : {'✅' if _settings.get('xanax_stacking') else '❌'}"
                )
                log(f"📲 Telegram: settings saved: {_settings}")
            elif key in _settings:
                _settings[key] = not _settings[key]

                if key == "xanax_stacking":
                    if _settings["xanax_stacking"]:
                        _tg_answer_callback(cb_id, "💊 Xanax Stack ON")
                        _tg_send(
                            f"💊 <b>Xanax Stacking ON</b>\n"
                            f"Target: {_settings.get('xanax_target', 1000)} energy\n"
                            f"Energy toggle forced OFF while stacking.\n"
                            f"Flight + Nerve run normally.\n"
                            f"Use /setxanaxstack to change target."
                        )
                    else:
                        _tg_answer_callback(cb_id, "💊 Xanax Stack OFF")
                        _tg_send("💊 <b>Xanax Stacking OFF</b>\nEnergy toggle restored to your settings.")
                    save_settings()
                    if msg_id:
                        _tg_edit_keyboard(msg_id, _tg_settings_keyboard())
                    return

                if key == "egg_speed_hunt":
                    if _settings["egg_speed_hunt"]:
                        # Turning ON — disable everything else
                        _settings["flight"]          = False
                        _settings["energy"]          = False
                        _settings["nerve"]           = False
                        save_settings()
                        _tg_answer_callback(cb_id, "🥚 Speed Hunt ON")
                        _tg_send(
                            "🥚 <b>Egg Speed Hunt ON</b>\n"
                            "Auto-disabled:\n"
                            "Flight ❌ | Energy ❌ | Nerve ❌"
                        )
                    else:
                        # Turning OFF — restore main functions
                        _settings["flight"] = True
                        _settings["energy"] = True
                        _settings["nerve"]  = True
                        save_settings()
                        _tg_answer_callback(cb_id, "🥚 Speed Hunt OFF")
                        _tg_send(
                            "🥚 <b>Egg Speed Hunt OFF</b>\n"
                            "Restored:\n"
                            "Flight ✅ | Energy ✅ | Nerve ✅"
                        )
                    if msg_id:
                        _tg_edit_keyboard(msg_id, _tg_settings_keyboard())
                    return

                if key == "war_mode":
                    WAR_MODE = _settings["war_mode"]
                save_settings()
                state = "✅ ON" if _settings[key] else "❌ OFF"
                _tg_answer_callback(cb_id, f"{key}: {state}")
                if msg_id:
                    _tg_edit_keyboard(msg_id, _tg_settings_keyboard())
            else:
                _tg_answer_callback(cb_id)
            return

        if cb_data.startswith("pri:"):
            parts = cb_data.split(":", 2)
            if len(parts) == 2 and parts[1] == "done":
                _tg_answer_callback(cb_id, "✅ Priorities saved!")
                _tg_send(
                    f"<b>✅ Priorities saved</b>\n" +
                    "\n".join(f"  {i+1}. {item} ({FLIGHT_TIMES.get(cc,{}).get('name',cc)})"
                              for i, (cc, item) in enumerate(PRIORITY_TARGETS))
                )
                log(f"📲 Telegram: priorities saved: {PRIORITY_TARGETS}")
            elif len(parts) == 3:
                _, cc, item_name = parts
                target = (cc, item_name)
                if target in PRIORITY_TARGETS:
                    PRIORITY_TARGETS.remove(target)
                    action = "removed"
                else:
                    PRIORITY_TARGETS.append(target)
                    action = "added"
                # Update derived globals
                ITEM_PRIORITY  = list(dict.fromkeys(i for _, i in PRIORITY_TARGETS))
                DEFAULT_COUNTRY = PRIORITY_TARGETS[0][0] if PRIORITY_TARGETS else "cay"
                save_priorities()
                _tg_answer_callback(cb_id, f"{'✅' if action == 'added' else '❌'} {item_name}")
                # Update keyboard in place
                if msg_id:
                    _tg_edit_keyboard(msg_id, _tg_priority_keyboard())
            else:
                _tg_answer_callback(cb_id)
        return

    # ── Handle text commands ───────────────────────────────────────────────
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return

    chat_id = msg.get("chat", {}).get("id")
    text    = (msg.get("text") or "").strip()

    # Security — only respond to the owner
    if chat_id != TELEGRAM_CHAT_ID:
        return

    cmd = text.split()[0].lower().split("@")[0] if text else ""

    if cmd == "/start":
        if _bot_paused.is_set():
            _bot_paused.clear()
            _tg_send("▶️ <b>Bot resumed.</b>")
            log("📲 Telegram: bot resumed")
        else:
            _tg_send("ℹ️ Bot is already running.")

    elif cmd == "/pause":
        if not _bot_paused.is_set():
            _bot_paused.set()
            _tg_send("⏸ <b>Bot paused.</b> Send /start to resume.")
            log("📲 Telegram: bot paused")
        else:
            _tg_send("ℹ️ Bot is already paused.")

    elif cmd == "/reset":
        _tg_send("💣 <b>Full reset triggered.</b> Wiping browser and restarting...")
        log("📲 Telegram: full reset triggered")
        time.sleep(1)
        fresh_browser_restart(wipe_profile=True)
        _restart_program()

    elif cmd == "/status":
        _tg_send(_tg_status_text())

    elif cmd == "/setwindow":
        global ITEM_RESTOCK_WINDOWS
        parts = text.split(None, 3)
        if len(parts) == 1:
            # Show all available items with current windows
            lines = ["<b>⏱ Restock Windows</b>", f"Default: {RESTOCK_WINDOW_EARLY} to +{RESTOCK_WINDOW_LATE}", ""]
            by_country = {}
            for cc, item in ALL_POSSIBLE_TARGETS:
                country = FLIGHT_TIMES.get(cc, {}).get("name", cc)
                by_country.setdefault(country, []).append(item)
            for country, items in by_country.items():
                lines.append(f"<b>{country}:</b>")
                for item in items:
                    win = ITEM_RESTOCK_WINDOWS.get(item)
                    win_str = f"[{win[0]}, +{win[1]}]" if win else "default"
                    lines.append(f"  {item} — {win_str}")
            lines.append("")
            lines.append("Usage: /setwindow Xanax -2 5")
            lines.append("       /setwindow Xanax reset")
            _tg_send("\n".join(lines))
        else:
            try:
                if len(parts) < 3:
                    raise ValueError("not enough args")
                item_name = parts[1]
                if parts[2].lower() == "reset":
                    if item_name in ITEM_RESTOCK_WINDOWS:
                        del ITEM_RESTOCK_WINDOWS[item_name]
                        _tg_send(f"✅ <b>{item_name}</b> window reset to default ({RESTOCK_WINDOW_EARLY} to +{RESTOCK_WINDOW_LATE})")
                        log(f"📲 Telegram: window reset for {item_name}")
                    else:
                        _tg_send(f"ℹ️ {item_name} has no custom window — already using default")
                elif len(parts) == 4:
                    early = int(parts[2])
                    late  = int(parts[3])
                    if early > late:
                        raise ValueError("early must be ≤ late")
                    ITEM_RESTOCK_WINDOWS[item_name] = (early, late)
                    _tg_send(
                        f"✅ Window set for <b>{item_name}</b>: {early} to +{late}\n"
                        f"Land {abs(early)}min {'before' if early < 0 else 'after'} restock → up to {late}min after"
                    )
                    log(f"📲 Telegram: window for {item_name} = ({early}, {late})")
                else:
                    raise ValueError("bad args")
            except Exception as e:
                _tg_send(
                    f"⚠️ Error: {e}\n"
                    "Usage:\n"
                    "  /setwindow           → show all items\n"
                    "  /setwindow Xanax -2 5\n"
                    "  /setwindow Xanax reset"
                )

    elif cmd == "/setconfidence":
        parts = text.split()
        try:
            val = float(parts[1])
            if val < 0.0 or val > 1.0:
                raise ValueError("must be 0.0–1.0")
            _settings["predict_confidence"] = val
            save_settings()
            global PREDICT_MIN_CONFIDENCE
            PREDICT_MIN_CONFIDENCE = val
            _tg_send(
                f"✅ Predict confidence set to <b>{val}</b>\n"
                f"Bot uses tracker API when confidence ≥ {val}, fallback otherwise.\n"
                f"0.0 = always use API | 1.0 = never use API"
            )
            log(f"📲 Telegram: predict_confidence = {val}")
        except (IndexError, ValueError) as e:
            _tg_send(
                f"⚠️ Error: {e}\n"
                "Usage: /setconfidence 0.5\n"
                "Range: 0.0–1.0"
            )

    elif cmd == "/setlaststockbuffer":
        parts = text.split()
        try:
            val = int(parts[1])
            if val > 0:
                raise ValueError("must be 0 or negative (e.g. -5)")
            _settings["stock_buffer"] = val
            save_settings()
            effective = f"16m + ({val}m) = {16+val}m" if val != 0 else "no buffer applied"
            _tg_send(
                f"✅ Stock safety buffer set to <b>{val}m</b>\n\n"
                f"Example: if stock lasts 16m after restock\n"
                f"  Effective window = 16 + ({val}) = <b>{16+val}m</b>\n\n"
                f"Bot will only fly if it lands <b>before</b> that window closes.\n"
                f"Use <b>0</b> to disable the buffer."
            )
            log(f"📲 Telegram: stock_buffer = {val}")
        except (IndexError, ValueError) as e:
            current = _settings.get("stock_buffer", -5)
            _tg_send(
                f"⚠️ {e}\n\n"
                f"<b>Usage:</b> /setlaststockbuffer -5\n\n"
                f"<b>What it does:</b>\n"
                f"Adds a safety margin to avoid arriving when stock is almost gone.\n"
                f"Example: stock lasts 16m → with -5 buffer → effective 11m\n"
                f"Bot won't fly if it lands after minute 11.\n\n"
                f"<b>Current buffer:</b> {current}m\n"
                f"<b>Range:</b> -60 to 0 (0 = disabled)"
            )

    elif cmd == "/setxanaxstack":
        parts = text.split()
        try:
            val = int(parts[1])
            if val < 100 or val > 5000:
                raise ValueError("must be 100–5000")
            _settings["xanax_target"] = val
            save_settings()
            xanax_needed = max(0, (val - 100) // 250 + 1)  # rough estimate
            _tg_send(
                f"💊 <b>Xanax Stack target set to {val} energy</b>\n\n"
                f"Bot will consume Xanax until you reach {val}E.\n"
                f"Roughly ~{xanax_needed} Xanax needed from base.\n\n"
                f"Enable stacking via /settings → 💊 Xanax Stack"
            )
            log(f"📲 Telegram: xanax_target = {val}")
        except (IndexError, ValueError) as e:
            current = _settings.get("xanax_target", 1000)
            _tg_send(
                f"⚠️ {e}\n\n"
                f"<b>Usage:</b> /setxanaxstack 1000\n\n"
                f"<b>What it does:</b>\n"
                f"Sets the energy target for Xanax stacking mode.\n"
                f"Bot consumes Xanax (250E each) until this target.\n"
                f"Energy gym is disabled while stacking.\n\n"
                f"<b>Current target:</b> {current}E\n"
                f"<b>Range:</b> 100–5000"
            )

    elif cmd == "/predict":
        parts = text.split(None, 2)
        if len(parts) == 1:
            # No args — show country selection keyboard
            CC_LABELS = [
                ("mex", "🇲🇽 Mexico"),     ("cay", "🏝 Cayman"),      ("can", "🇨🇦 Canada"),
                ("haw", "🌺 Hawaii"),      ("uni", "🇬🇧 UK"),          ("arg", "🇦🇷 Argentina"),
                ("swi", "🇨🇭 Switzerland"),("jap", "🇯🇵 Japan"),      ("chi", "🇨🇳 China"),
                ("uae", "🇦🇪 UAE"),        ("sou", "🇿🇦 S.Africa"),
            ]
            rows = []
            row  = []
            for cc, label in CC_LABELS:
                row.append({"text": label, "callback_data": f"pred_cc:{cc}"})
                if len(row) == 3:
                    rows.append(row)
                    row = []
            if row:
                rows.append(row)
            _tg_send_inline("🔮 <b>Predict — Select country:</b>", {"inline_keyboard": rows})

        elif len(parts) == 2:
            # Only cc given — show item list for that country
            cc_arg  = parts[1].lower()
            items   = [item for c, item in ALL_POSSIBLE_TARGETS if c == cc_arg]
            country = FLIGHT_TIMES.get(cc_arg, {}).get("name", cc_arg)
            if not items:
                _tg_send(f"⚠️ Unknown country code: {cc_arg}\nUse: mex cay can haw uni arg swi jap chi uae sou")
            else:
                rows = []
                row  = []
                for item in items:
                    row.append({"text": item, "callback_data": f"pred_item:{cc_arg}:{item}"})
                    if len(row) == 2:
                        rows.append(row)
                        row = []
                if row:
                    rows.append(row)
                _tg_send_inline(f"🔮 <b>Predict — {country}. Select item:</b>", {"inline_keyboard": rows})

        else:
            # Full command: /predict jap Xanax
            cc_arg       = parts[1].lower()
            item_arg     = parts[2]
            country_name = FLIGHT_TIMES.get(cc_arg, {}).get("name", cc_arg)
            _tg_run_predict(cc_arg, item_arg, country_name)

    elif cmd == "/tracker":
        if not PRIORITY_TARGETS:
            _tg_send("No priority targets set. Use /priority to set them.")
        else:
            lines = ["<b>🔮 Tracker — Priority Items</b>"]
            for cc, item_name in PRIORITY_TARGETS:
                country = FLIGHT_TIMES.get(cc, {}).get("name", cc)
                pred    = _call_predict_api(cc, item_name)

                if not pred:
                    lines.append(f"\n<b>{item_name} ({country})</b>\n  ⚠️ API unavailable")
                    continue

                a           = pred.get("analysis", {})
                fly         = pred.get("fly")
                fly_icon    = "✅ FLY" if fly else ("❌ SKIP" if fly is False else "❓ LOW DATA")
                conf        = pred.get("confidence", 0)
                runway      = a.get("stockRunway")
                restock_eta = pred.get("restockEta")
                restock_str = f"{restock_eta}m" if restock_eta is not None else "?"
                stock       = a.get("currentStock", 0)
                depl        = a.get("depletionRate")
                nw          = pred.get("nextWindowMins")
                lines.append(
                    f"\n<b>{item_name} ({country})</b>\n"
                    f"  {fly_icon} | conf={conf}\n"
                    f"  Stock    : {stock} | runway={str(runway)+'m' if runway is not None else '?'}\n"
                    f"  Depletion: {depl} units/min\n"
                    f"  Restock  : {restock_str}\n"
                    f"  Reason   : {pred.get('reason','?')}\n"
                    f"  Next win : {str(nw)+'m' if nw is not None else '?'}"
                )
            _tg_send("\n".join(lines))
            log("📲 Telegram: /tracker sent")

    elif cmd == "/settrainpoints":
        global TRAIN_POINTS
        parts = text.split()
        try:
            val = int(parts[1])
            if val < 1 or val > 999:
                raise ValueError("must be 1-999")
            TRAIN_POINTS = val
            _settings["train_points"] = val
            save_settings()
            _tg_send(f"✅ Train points set to <b>{val}</b> reps per session.")
            log(f"📲 Telegram: TRAIN_POINTS = {val}")
        except (IndexError, ValueError) as e:
            _tg_send(
                f"⚠️ Error: {e}\n"
                "Usage: /settrainpoints 99\n"
                "Range: 1–999"
            )

    elif cmd == "/settings":
        header = (
            "<b>⚙️ Bot Settings</b>\n"
            "Tap to toggle on/off. Changes take effect immediately."
        )
        _tg_send_inline(header, _tg_settings_keyboard())
        log("📲 Telegram: /settings keyboard sent")

    elif cmd == "/resumeflight":
        if _flight_held.is_set():
            _flight_held.clear()
            _tg_send("▶️ <b>Flight resumed!</b> Re-evaluating destination...")
            log("📲 Telegram: /resumeflight — flight unblocked")
        else:
            # Toggle fly_low_cash
            _settings["fly_low_cash"] = not _settings.get("fly_low_cash", False)
            save_settings()
            if _settings["fly_low_cash"]:
                _tg_send(
                    "⚠️ <b>Low Cash Override ON</b>\n"
                    "Bot will fly even with insufficient cash.\n"
                    "Send /resumeflight again to turn OFF."
                )
                log("📲 Telegram: fly_low_cash = True")
            else:
                _tg_send("✅ <b>Low Cash Override OFF</b>\nNormal cash check restored.")
                log("📲 Telegram: fly_low_cash = False")

    elif cmd == "/priority":
        active = PRIORITY_TARGETS
        header = (
            "<b>🎯 Set Travel Priorities</b>\n"
            "Tap to toggle on/off. Order = tap sequence.\n"
            f"Active: {len(active)} item(s)"
        )
        _tg_send_inline(header, _tg_priority_keyboard())
        log("📲 Telegram: /priority keyboard sent")

    elif cmd == "/setenergy":
        parts = text.split()
        try:
            if len(parts) == 2:
                val = int(parts[1])
                ENERGY_MIN = val
                ENERGY_MAX = val
                _energy_threshold_now = val
                _settings["energy_min"] = val
                _settings["energy_max"] = val
                save_settings()
                _tg_send(f"✅ Energy threshold fixed at <b>{val}</b>.\nTakes effect immediately.")
                log(f"📲 Telegram: energy fixed at {val}")
            elif len(parts) == 3:
                lo, hi = int(parts[1]), int(parts[2])
                if lo > hi:
                    lo, hi = hi, lo
                ENERGY_MIN = lo
                ENERGY_MAX = hi
                _energy_threshold_now = random.randint(lo, hi)
                _settings["energy_min"] = lo
                _settings["energy_max"] = hi
                save_settings()
                _tg_send(f"✅ Energy range set to <b>{lo}–{hi}</b>.\nCurrent threshold: <b>{_energy_threshold_now}</b>.")
                log(f"📲 Telegram: energy range {lo}–{hi}, threshold now {_energy_threshold_now}")
            else:
                raise ValueError("bad args")
        except Exception as e:
            log(f"📲 Telegram: /setenergy error: {e}")
            _tg_send(
                f"⚠️ Error: {e}\n"
                "Usage:\n"
                "  /setenergy 90        → fixed threshold\n"
                "  /setenergy 75 110    → random range"
            )

    elif cmd == "/setmode":
        parts = text.split()
        if len(parts) < 2:
            mode_str = "⚔️ WAR" if WAR_MODE else "🕊 Normal"
            _tg_send(f"Current mode: <b>{mode_str}</b>\nUsage: /setmode war  or  /setmode normal")
        else:
            arg = parts[1].lower()
            if arg in ("war", "on", "1", "true"):
                WAR_MODE = True
                _settings["war_mode"] = True
                save_settings()
                _tg_send("⚔️ <b>War mode ON</b> — micro jitter, no browsing delays.")
                log("📲 Telegram: WAR_MODE = True")
            elif arg in ("normal", "off", "0", "false"):
                WAR_MODE = False
                _settings["war_mode"] = False
                save_settings()
                _tg_send("🕊 <b>Normal mode ON</b> — human delays, stealth play.")
                log("📲 Telegram: WAR_MODE = False")
            else:
                _tg_send("⚠️ Unknown mode. Use: /setmode war  or  /setmode normal")

    elif cmd == "/help":
        _tg_send(
            "<b>📋 Bot Commands</b>\n"
            "\n"
            "<b>🤖 Bot Control</b>\n"
            "/start         — resume bot after pause\n"
            "/pause         — pause all actions\n"
            "/reset         — full browser wipe + restart\n"
            "/status        — full dashboard (cash, flight, config, last run)\n"
            "\n"
            "<b>⚙️ Settings</b>\n"
            "/settings      — toggle flight / energy / nerve / war mode / egg hunt\n"
            "\n"
            "<b>✈️ Travel</b>\n"
            "/priority                  — choose which items to fly to\n"
            "/resumeflight              — toggle low cash override (fly regardless of cash)\n"
            "/setwindow                 — show all items + current windows\n"
            "/setwindow Xanax -2 5      — set landing window: 2min before to 5min after restock\n"
            "/setwindow Xanax reset     — reset item window back to default\n"
            "\n"
            "<b>🔮 Stock Tracker</b>\n"
            "/tracker                   — live predict data for all priority items\n"
            "/predict jap Xanax         — manual predict check for one item\n"
            "/setconfidence 0.5         — min tracker confidence to use API\n"
            "                             (0=always use, 1=always use fallback)\n"
            "/setlaststockbuffer -5     — safety buffer for stock duration\n"
            "                             e.g. -5 = treat 16m stock as 11m\n"
            "                             avoids landing when stock almost gone\n"
            "\n"
            "<b>💊 Xanax Stacking</b>\n"
            "/setxanaxstack 1000        — set energy target for xanax stacking\n"
            "                             bot consumes xanax (250E each) until target\n"
            "                             enable via /settings → 💊 Xanax Stack\n"
            "\n"
            "/settrainpoints 99         — gym reps per session (1–999)\n"
            "\n"
            "<b>⚡ Energy</b>\n"
            "/setenergy 90              — fixed energy threshold\n"
            "/setenergy 75 110          — random range between 75–110\n"
            "\n"
            "<b>⚔️ Mode</b>\n"
            "/setmode war               — war mode: fast timing, stock only\n"
            "/setmode normal            — normal mode: human delays\n"
            "\n"
            "/help                      — show this message"
        )
    else:
        if text.startswith("/"):
            _tg_send(f"❓ Unknown command: {cmd}\nTry /help")


def _tg_save_offset(offset: int):
    """Persist the last processed update_id so restarts don't replay it."""
    try:
        os.makedirs(os.path.dirname(TELEGRAM_OFFSET_FILE), exist_ok=True)
        with open(TELEGRAM_OFFSET_FILE, "w") as f:
            f.write(str(offset))
    except Exception as e:
        log(f"   ⚠️ Could not save Telegram offset: {e}")


def _tg_load_offset() -> int | None:
    """Load persisted offset from previous run. Returns None if not found."""
    try:
        with open(TELEGRAM_OFFSET_FILE, "r") as f:
            val = f.read().strip()
            return int(val) if val.isdigit() else None
    except Exception:
        return None


def _tg_poll_loop():
    """Long-poll Telegram for updates in a background daemon thread."""
    log("📲 Telegram bot polling started")
    # Resume from saved offset so restarts don't replay old commands (e.g. /reset loop)
    offset = _tg_load_offset()
    if offset is not None:
        log(f"📲 Telegram: resuming from offset {offset}")
    while True:
        try:
            params = {"timeout": 30, "allowed_updates": ["message", "callback_query"]}
            if offset is not None:
                params["offset"] = offset
            resp = requests.get(
                f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates",
                params=params,
                timeout=40,
            )
            data = resp.json()
            if data.get("ok"):
                for update in data.get("result", []):
                    offset = update["update_id"] + 1
                    _tg_save_offset(offset)   # persist immediately after each update
                    try:
                        _tg_handle(update)
                    except Exception as e:
                        log(f"   ⚠️ Telegram handler error: {e}")
        except Exception as e:
            log(f"   ⚠️ Telegram poll error: {e}")
            time.sleep(5)


def start_telegram_bot():
    """Spawn the Telegram polling loop as a background daemon thread."""
    t = threading.Thread(target=_tg_poll_loop, name="TelegramBot", daemon=True)
    t.start()
    return t

# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────

def main():
    log(f"{'='*55}")
    log(f"🚀 Bot started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    log(f"📝 Log: {LOG_PATH}")
    log(f"🎯 Mode: {ENERGY_ACTION_MODE}")
    log(f"🌍 Item priority: {' > '.join(ITEM_PRIORITY)}")
    log(f"🏠 Default country: {FLIGHT_TIMES[DEFAULT_COUNTRY]['name']}")
    log(f"{'='*55}\n")

    # ── Load persisted settings and priority targets ──────────────────────
    load_settings()
    load_priorities()
    load_egg_stats()

    # ── Start Telegram bot thread ─────────────────────────────────────────────
    start_telegram_bot()
    _tg_send(f"🚀 <b>Torn bot started</b>\nMode: {'⚔️ WAR' if WAR_MODE else '🕊 Normal'}\nEnergy: {ENERGY_MIN}–{ENERGY_MAX}\nLog: {LOG_PATH}")

    ensure_brave_cdp()

    # DroqsDB is fetched live inside pick_best_destination() each travel cycle

    global _energy_threshold_now, _nerve_trigger_now
    energy_threshold      = roll_energy_threshold()
    _energy_threshold_now = energy_threshold
    nerve_trigger         = roll_nerve_trigger()
    _nerve_trigger_now    = nerve_trigger

    # Track consecutive CF challenge failures to trigger a fresh browser restart.
    # After CF_FAIL_LIMIT failed solve attempts in a row, the profile is wiped
    # and Brave is restarted with a fresh fingerprint.
    cf_fail_count = 0
    CF_FAIL_LIMIT = 3
    loop_fail_count = 0
    LOOP_FAIL_LIMIT = 2   # 2 consecutive errors → full wipe + restart

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP_URL)
        context = browser.contexts[0] if browser.contexts else browser.new_context()

        # ── Enforce single tab — close every extra page ───────────────────────
        all_pages = context.pages
        if all_pages:
            page = all_pages[0]
            for extra in all_pages[1:]:
                try:
                    extra.close()
                    log(f"   🗑️  Closed extra tab: {extra.url[:60]}")
                except Exception:
                    pass
            log(f"   📄 Using existing tab: {page.url[:60]}")
        else:
            page = context.new_page()
            log("   📄 No existing tab — opened new one")

        # ── Auto-dismiss any JS alert/confirm/prompt dialogs ──────────────────
        # Prevents ProtocolError crash when Torn or CF fires a dialog and
        # Playwright's internal handler races with it.
        def _on_dialog(dialog):
            try:
                log(f"   🪟 Auto-dismissing dialog: [{dialog.type}] {dialog.message[:80]}")
                dialog.dismiss()
            except Exception:
                pass
        page.on("dialog", _on_dialog)

        page.goto("https://www.torn.com/", wait_until="domcontentloaded")
        reading_pause(1000, 2500)

        # ── Login ─────────────────────────────────────────────────────────────
        if TORN_COOKIES:
            # ── Cookie auth — inject all session cookies, skip login form ────────
            try:
                context.add_cookies(TORN_COOKIES)
                page.goto("https://www.torn.com/index.php", wait_until="domcontentloaded")
                reading_pause(800, 1500)
                check_and_solve_captcha(page)
                if page.locator("a.bar___Bv5Ho.energy___hsTnO").count() > 0:
                    log("✅ Logged in via cookies")
                else:
                    log("⚠️ Cookie auth failed — cookies may be expired. Update TORN_COOKIES.")
            except Exception as e:
                log(f"⚠️ Cookie inject error: {e}")
        else:
            # ── Fallback: email + password + OTP ─────────────────────────────
            try:
                check_and_solve_captcha(page)
                login_btn = page.get_by_role("button", name="Login")
                login_btn.wait_for(timeout=5000)
                human_click(login_btn)
                reading_pause(500, 1200)

                username = page.get_by_role("textbox", name="email address", exact=False)
                username.wait_for(timeout=5000)
                human_fill(username, "slambergamer@gmail.com")
                human_pause(300, 800)

                pw = page.locator("#password")
                pw.wait_for(timeout=5000)
                human_fill(pw, "IBYB7MHE")
                reading_pause(400, 1000)

                page.locator('[name="btnLogin"]').wait_for(timeout=5000)
                human_click(page.locator('[name="btnLogin"]'))
                reading_pause(1500, 3000)
                check_and_solve_captcha(page)
                handle_otp_page(page)   # auto-fill OTP if Torn asks for it
            except Exception as e:
                log(f"Login skipped (already logged in?): {e}")

        # ── Set dark theme — only if currently in light mode ─────────────────
        try:
            is_dark = page.evaluate(
                "() => document.body.classList.contains('dark-mode')"
            )
            if is_dark:
                log("🌙 Dark theme already active — skipping")
            else:
                log("🌙 Light theme detected — switching to Dark Theme")
                avatar = page.locator("//div[@class='circle-wrapper']//*[name()='svg']")
                avatar.wait_for(state="visible", timeout=3000)
                human_click(avatar)
                dark_mode = page.locator("//li[@class='setting dark-mode']/label[1]")
                dark_mode.wait_for(state="visible", timeout=3000)
                human_click(dark_mode)
                time.sleep(3)
        except Exception as e:
            log(f"⚠️ Theme check/change failed: {e}")

        # ── Main loop ─────────────────────────────────────────────────────────
        while True:
            try:
                # ── Pause gate — block here until /start is sent ──────────────
                if _bot_paused.is_set():
                    log("⏸ Bot paused — waiting for /start via Telegram...")
                    while _bot_paused.is_set():
                        keep_alive_browser(page)
                        time.sleep(5)
                    log("▶️ Bot resumed")

                # ── Keep-alive — prevent CF on idle browser ────────────────────
                keep_alive_browser(page)

                log(f"\n{'='*55}")
                log(f"🔍 Scan at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
                log(f"{'='*55}")
                update_activity()   # reset keep-alive timer — bot is active

                if WAR_MODE:
                    war_jitter(100, 300)
                else:
                    reading_pause(800, 3000)

                # DroqsDB fetched live inside pick_best_destination() when travel is evaluated

                # ── HOSPITAL CHECK — must run before location/travel checks ───
                # wait_for_connectivity handles ERR_NAME_NOT_RESOLVED that can linger
                # after a CF challenge clears — retries until torn.com actually loads.
                try:
                    page.goto("https://www.torn.com/index.php", wait_until="domcontentloaded", timeout=15000)
                except Exception:
                    log("   ⚠️ index.php unreachable — waiting for connectivity...")
                    if not wait_for_connectivity(page, "https://www.torn.com/index.php"):
                        hourly_sleep()
                        continue
                reading_pause(600, 1200) if not WAR_MODE else war_jitter(100, 200)

                # ── Page state detection — log what we're looking at ──────────
                page_state = detect_page_state(page)

                # ── OTP page — handle if stuck here ──────────────────────────
                if page_state == "otp":
                    log("   🔑 Stuck on OTP page — handling now...")
                    handle_otp_page(page)
                    hourly_sleep()
                    continue

                # ── Login page — not authenticated, attempt login ─────────────
                if page_state == "login":
                    log("   🔐 Not logged in — attempting login...")
                    try:
                        check_and_solve_captcha(page)
                        login_btn = page.get_by_role("button", name="Login")
                        login_btn.wait_for(timeout=5000)
                        human_click(login_btn)
                        reading_pause(500, 1200)
                        username = page.get_by_role("textbox", name="email address", exact=False)
                        username.wait_for(timeout=5000)
                        human_fill(username, "slambergamer@gmail.com")
                        human_pause(300, 800)
                        pw = page.locator("#password")
                        pw.wait_for(timeout=5000)
                        human_fill(pw, "IBYB7MHE")
                        reading_pause(400, 1000)
                        page.locator('[name="btnLogin"]').wait_for(timeout=5000)
                        human_click(page.locator('[name="btnLogin"]'))
                        reading_pause(1500, 3000)
                        check_and_solve_captcha(page)
                        handle_otp_page(page)
                    except Exception as login_err:
                        log(f"   ⚠️ Loop login attempt failed: {login_err}")
                    hourly_sleep()
                    continue
                # Checked immediately after page load so we know if CF is blocking.
                # On persistent failure (CF_FAIL_LIMIT hits), wipe profile and restart.
                if _is_cf_managed_challenge(page) or _is_cf_interactive_turnstile(page):
                    solved = check_and_solve_captcha(page)
                    if not solved:
                        cf_fail_count += 1
                        log(f"⚠️ CF unresolved ({cf_fail_count}/{CF_FAIL_LIMIT})")
                        if cf_fail_count >= CF_FAIL_LIMIT:
                            log("♻️  Persistent CF block — restarting Brave (no wipe)...")
                            cf_fail_count = 0
                            if fresh_browser_restart(wipe_profile=False):
                                # Reconnect Playwright to the freshly launched browser
                                try:
                                    browser = p.chromium.connect_over_cdp(CDP_URL)
                                    context = browser.contexts[0] if browser.contexts else browser.new_context()
                                    page    = context.new_page()
                                    page.goto("https://www.torn.com/", wait_until="domcontentloaded")
                                    reading_pause(2000, 4000) if not WAR_MODE else war_jitter(200, 500)
                                    check_and_solve_captcha(page)
                                    log("♻️  Reconnected with fresh profile — re-login required")
                                except Exception as re_err:
                                    log(f"⚠️ Reconnect failed: {re_err}")
                        hourly_sleep()
                        continue
                    else:
                        cf_fail_count = 0
                else:
                    cf_fail_count = 0
                    check_and_solve_captcha(page)

                if check_and_wait_hospital(page):
                    log("   🏥 Released from hospital — checking location...")
                    page.goto("https://www.torn.com/index.php", wait_until="domcontentloaded")
                    reading_pause(600, 1200) if not WAR_MODE else war_jitter(100, 200)
                    check_and_solve_captcha(page)
                    loc_after = detect_location(page)
                    log(f"   📍 Post-hospital location: {loc_after}")
                    if loc_after in ("abroad", "traveling"):
                        log("   🌍 Was hospitalized abroad — recovering now...")
                        recover_if_abroad(page)
                        log("   🔄 Abroad recovery after hospital complete")
                    hourly_sleep()
                    continue

                # ── Recovery: handle abroad/traveling before anything else ────
                recovered = recover_if_abroad(page)
                if recovered:
                    log("   🔄 Recovery complete — resuming normal loop")
                    hourly_sleep()
                    continue

                # Stats are read from the index.php already loaded above
                energy_el = page.locator("a.bar___Bv5Ho.energy___hsTnO.bar-desktop___p5Cas p.bar-value___NTdce")
                nerve_el  = page.locator("a.bar___Bv5Ho.nerve___AyYv_.bar-desktop___p5Cas p.bar-value___NTdce")
                energy_el.wait_for(timeout=5000)
                nerve_el.wait_for(timeout=5000)

                energy_parsed = parse_fraction(energy_el.inner_text().strip())
                nerve_parsed  = parse_fraction(nerve_el.inner_text().strip())

                if not energy_parsed or not nerve_parsed:
                    log("⚠️ Could not parse stats — retrying next cycle")
                    hourly_sleep()
                    continue

                energy_current, energy_max = energy_parsed
                nerve_current,  nerve_max  = nerve_parsed

                log(f"⚡ Energy: {energy_current}/{energy_max} (trigger≥{energy_threshold}) | "
                    f"🧠 Nerve: {nerve_current}/{nerve_max} (trigger≥{nerve_trigger})")

                acted = False

                # ── Egg speed hunt — takes over entire cycle ──────────────────
                if _settings.get("egg_speed_hunt"):
                    egg_speed_hunt(page)
                    continue

                # ── Nerve action ──────────────────────────────────────────────
                if _settings["nerve"] and nerve_current >= nerve_trigger:
                    if WAR_MODE:
                        delay = random.uniform(0.2, 0.5)
                        log(f"   ⚔️ [WAR] {delay:.2f}s before crime...")
                        time.sleep(delay)
                        war_nerve_action(page)
                    else:
                        delay = random.uniform(2.0, 8.0)
                        log(f"   ⏳ {delay:.1f}s before crime...")
                        time.sleep(delay)
                        nerve_action(page)
                    nerve_trigger      = roll_nerve_trigger()
                    _nerve_trigger_now = nerve_trigger
                    acted = True
                elif not _settings["nerve"]:
                    log("   🧠 Nerve disabled via /settings — skipping")

                # ── Xanax stacking ───────────────────────────────────────────
                if _settings.get("xanax_stacking"):
                    xanax_stack_action(page)
                    acted = True

                # ── Energy action (gym) ───────────────────────────────────────
                # Force energy OFF when xanax stacking
                energy_enabled = _settings["energy"] and not _settings.get("xanax_stacking")
                if _energy_threshold_now is not None and _energy_threshold_now != energy_threshold:
                    log(f"   ⚡ Energy threshold updated by Telegram: {energy_threshold} → {_energy_threshold_now}")
                    energy_threshold = _energy_threshold_now
                if energy_enabled and energy_current >= energy_threshold:
                    if WAR_MODE:
                        delay = random.uniform(0.2, 0.5)
                        log(f"   ⚔️ [WAR] {delay:.2f}s before gym...")
                        time.sleep(delay)
                        war_gym(page)
                    else:
                        delay = random.uniform(3.0, 10.0)
                        log(f"   ⏳ {delay:.1f}s before gym...")
                        time.sleep(delay)
                        energy_action(page)
                    energy_threshold = roll_energy_threshold()
                    _energy_threshold_now = energy_threshold
                    acted = True
                elif not energy_enabled:
                    if _settings.get("xanax_stacking"):
                        log("   ⚡ Energy disabled — xanax stacking active")
                    else:
                        log("   ⚡ Energy disabled via /settings — skipping")

                # ── Travel action ─────────────────────────────────────────────
                if _settings["flight"]:
                    if WAR_MODE:
                        delay = random.uniform(0.2, 0.5)
                        log(f"   ⚔️ [WAR] {delay:.2f}s before travel check...")
                        time.sleep(delay)
                        war_travel_action(page)
                    else:
                        delay = random.uniform(2.0, 6.0)
                        log(f"   ⏳ {delay:.1f}s before travel check...")
                        time.sleep(delay)
                        travel_action(page)
                    acted = True
                else:
                    log("   ✈️ Flight disabled via /settings — skipping")


                if not acted:
                    log("💤 No conditions met.")

                loop_fail_count = 0   # clean cycle — reset consecutive failure counter

            except Exception as e:
                log(f"⚠️ Loop error: {e}")
                loop_fail_count += 1
                log(f"   ⚠️ Consecutive failures: {loop_fail_count}/{LOOP_FAIL_LIMIT}")
                if loop_fail_count >= LOOP_FAIL_LIMIT:
                    log("💣 Fail limit reached — wiping browser and restarting fresh...")
                    loop_fail_count = 0
                    fresh_browser_restart(wipe_profile=True)
                    _restart_program()

            hourly_sleep()


if __name__ == "__main__":
    main()