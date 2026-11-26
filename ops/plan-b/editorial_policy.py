"""Publication policy for the normal five-country Plan B edition."""
from datetime import timedelta


EFFECTIVE_ISSUE = '2026-11-27'
TARGET_ARTICLES = 7
MIN_ARTICLES = 6
MAX_PREVIOUS_DAY = 2
FOLLOW_UP_LABEL = '【延续关注】'


def previous_day(published, window_start):
    return window_start - timedelta(days=1) <= published < window_start
