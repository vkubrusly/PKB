"""python3 collectors/mail/test_showings.py — parser checks on synthetic samples.

Replace / extend with real e-mails (anonymized) as they arrive from the listing mailboxes.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from showings import match_listing, parse_showing, parse_when  # noqa: E402

LISTINGS = [
    {'id': 'L1', 'mls_number': 'OM712345', 'address': '2150 SW 45th Place Rd, Ocala, FL 34471'},
    {'id': 'L2', 'mls_number': None, 'address': '318 Lake Ivy Dr, Orlando, FL 32803'},
]


class ShowingParse(unittest.TestCase):
    def test_showingtime_request(self):
        body = """New Showing Request

2150 SW 45th Place Rd, Ocala, FL 34471 (MLS# OM712345)
Tuesday, September 29, 2026 2:00 PM - 2:30 PM

Buyer's Agent: Maria Silva
Brokerage: Keller Williams Cornerstone
Phone: (352) 555-0142
Email: maria.silva@kw.com

Appointment ID: 88231907"""
        r = parse_showing('callcenter@showingtime.com', 'Showing Request: 2150 SW 45th Place Rd', body, None, LISTINGS)
        self.assertEqual(r['event'], 'requested')
        self.assertEqual(r['source'], 'showingtime')
        self.assertEqual(r['listing_id'], 'L1')
        self.assertEqual(r['external_id'], '88231907')
        self.assertEqual(r['agent_name'], 'Maria Silva')
        self.assertEqual(r['agent_email'], 'maria.silva@kw.com')
        self.assertEqual(r['agent_phone'], '(352) 555-0142')
        self.assertEqual(r['agent_brokerage'], 'Keller Williams Cornerstone')
        self.assertTrue(r['starts_at'].startswith('2026-09-29T14:00:00-04:00'))
        self.assertTrue(r['ends_at'].startswith('2026-09-29T14:30'))

    def test_brokerbay_confirmed_numeric_date(self):
        body = 'Your booking at 318 Lake Ivy Drive has been confirmed.\nDate: 10/02/2026 @ 11:15am\nAgent: John Doe | john@remax.net | 407.555.9911'
        r = parse_showing('notifications@brokerbay.com', 'Booking Confirmed - 318 Lake Ivy Dr', body, None, LISTINGS)
        self.assertEqual((r['event'], r['source'], r['listing_id']), ('confirmed', 'brokerbay', 'L2'))
        self.assertEqual(r['agent_email'], 'john@remax.net')
        self.assertEqual(r['agent_name'], 'John Doe')
        self.assertTrue(r['starts_at'].startswith('2026-10-02T11:15'))
        self.assertTrue(r['external_id'].startswith('h'))

    def test_cancel_and_feedback(self):
        r = parse_showing('callcenter@showingtime.com', 'Showing Cancelled: OM712345', 'Sep 30, 2026 at 4:00 pm', None, LISTINGS)
        self.assertEqual(r['event'], 'cancelled')
        fb = parse_showing('feedback@showingtime.com', 'Feedback Received for 2150 SW 45th Pl Rd',
                           'Showing Feedback\nInterest level: Somewhat interested\nPrice: A little high\nComments: buyers loved the kitchen.\nView all feedback online',
                           None, LISTINGS)
        self.assertEqual(fb['event'], 'feedback')
        self.assertIn('loved the kitchen', fb['feedback_text'])
        self.assertNotIn('View all', fb['feedback_text'])

    def test_reply_tag_and_unrelated(self):
        r = parse_showing('agent@x.com', 'Re: Feedback on 2150 SW 45th Place Rd [Showing S-1A2B3C]', 'They are writing an offer', None, LISTINGS)
        self.assertEqual((r['event'], r['ref']), ('feedback_reply', 'S-1A2B3C'))
        self.assertIsNone(parse_showing('callcenter@showingtime.com', 'Showing Request: 999 Other St', '999 Other St', None, LISTINGS))
        self.assertIsNone(parse_showing('friend@gmail.com', 'lunch?', '2150 SW 45th Place Rd', None, LISTINGS))

    def test_match_by_address_variants(self):
        self.assertEqual(match_listing('at 2150 SW 45th Pl Rd today', LISTINGS)['id'], 'L1')
        self.assertIsNone(match_listing('12150 SW 45th Place Rd', LISTINGS))

    def test_when_missing(self):
        self.assertEqual(parse_when('no date here'), (None, None))


if __name__ == '__main__':
    unittest.main()
