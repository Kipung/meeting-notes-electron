import unittest

from backend.summary_formatting import (
    ACTION_ITEMS_MARKER,
    HIGH_IMPORTANCE_MARKER,
    SUMMARY_MARKER,
    contains_high_importance_language,
    count_summary_sentences,
    extract_summary_body,
    finalize_summary_output,
)


class SummaryFormattingTests(unittest.TestCase):
    def test_avoids_near_duplicate_summary_sentences_when_backfilling(self):
        transcript = (
            "The team reviewed sprint status and launch planning. "
            "Payments API remains a critical blocker for Tuesday's release."
        )
        raw_summary = "Summary:\nThe team reviewed sprint status.\n\nAction Items: none."

        output = finalize_summary_output(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertEqual(summary_body.count("reviewed sprint status"), 1)
        self.assertIn("critical blocker", summary_body)

    def test_merges_high_importance_section_into_summary(self):
        transcript = (
            "The team reviewed onboarding progress. "
            "A production outage is a critical blocker for Monday's launch. "
            "Alex will share a patch plan by Friday."
        )
        raw_summary = (
            "Summary:\n"
            "The team reviewed onboarding progress.\n\n"
            "High Importance:\n"
            "- Production outage is a critical blocker for Monday's launch.\n\n"
            "Action Items:\n"
            "- Alex will share a patch plan by Friday."
        )

        output = finalize_summary_output(raw_summary, transcript)

        self.assertIn(SUMMARY_MARKER, output)
        self.assertIn(ACTION_ITEMS_MARKER, output)
        self.assertNotIn(HIGH_IMPORTANCE_MARKER, output)
        self.assertIn("critical blocker", extract_summary_body(output).lower())

    def test_formats_action_items_for_student_coaching_roles(self):
        transcript = (
            "Student will email professor tonight. "
            "Coach will follow up Monday and coordinate tutoring if needed."
        )
        raw_summary = (
            "Summary:\n"
            "The session focused on communication and accountability.\n\n"
            "Action Items:\n"
            "student email professor tonight; coach follow up monday and coordinate tutoring"
        )

        output = finalize_summary_output(raw_summary, transcript)

        self.assertIn("- Student: email professor tonight", output)
        self.assertIn("- Coach: follow up monday and coordinate tutoring", output)

    def test_maps_coach_you_will_actions_to_student_owner(self):
        transcript = "Coach: You will email your professor tonight and submit the missed lab by Friday."
        raw_summary = (
            "Summary:\n"
            "The student and coach aligned on immediate follow-up.\n\n"
            "Action Items:\n"
            "- Coach: You will email your professor tonight and submit the missed lab by Friday."
        )

        output = finalize_summary_output(raw_summary, transcript)
        self.assertIn("- Student: email your professor tonight and submit the missed lab by Friday", output)

    def test_normalizes_month_spacing_in_summary(self):
        transcript = "Missing assignments may block eligibility by March 1."
        raw_summary = (
            "Summary:\n"
            "Missing assignments may block eligibility by March1.\n\n"
            "Action Items: none."
        )

        output = finalize_summary_output(raw_summary, transcript)
        self.assertIn("March 1", extract_summary_body(output))

    def test_summary_sentences_end_with_punctuation(self):
        transcript = (
            "Attendance is improving. "
            "There is still serious risk of failing biology if two more classes are missed."
        )
        raw_summary = (
            "Summary:\n"
            "Team aligned on attendance recovery\n\n"
            "High Importance:\n"
            "- serious risk of failing biology if two more classes are missed\n\n"
            "Action Items: none."
        )

        output = finalize_summary_output(raw_summary, transcript)
        summary_body = extract_summary_body(output)

        self.assertIn("missed.", summary_body)
        self.assertTrue(summary_body.strip().endswith("."))

    def test_rejects_placeholder_action_items(self):
        transcript = (
            "The session introduced coaching expectations and available support resources. "
            "No concrete follow-up commitments were assigned."
        )
        raw_summary = (
            "Summary:\n"
            "The student and coach discussed goals and support resources.\n\n"
            "Action Items:\n"
            "- Owner: Student Topic: establish routine Due Date: TBD\n"
            "- Action: none"
        )

        output = finalize_summary_output(raw_summary, transcript)
        self.assertIn("Action Items: none.", output)

    def test_replaces_noisy_model_sentence_with_grounded_transcript_sentence(self):
        transcript = (
            "The student is missing two assignments and may lose exam eligibility by March 1. "
            "Coach and student agreed to submit the missing work by Friday."
        )
        raw_summary = (
            "Summary:\n"
            "The coach needs the to submit both tonight and Friday has high-priority deadline update grades scheduled "
            "receive tutoring tomorrow will review's progress on Thursday morning.\n\n"
            "Action Items: none."
        )

        output = finalize_summary_output(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()
        self.assertIn("exam eligibility", summary_body)
        self.assertNotIn("review's progress", summary_body)

    def test_infers_high_importance_into_summary_when_missing(self):
        transcript = (
            "We discussed progress and open questions. "
            "There is a deadline on Tuesday and missing it creates risk for rollout."
        )
        raw_summary = "Summary:\nWe discussed progress and open questions.\n\nAction Items: none."

        output = finalize_summary_output(raw_summary, transcript)
        summary_body = extract_summary_body(output)

        self.assertTrue(contains_high_importance_language(summary_body))
        self.assertNotIn(HIGH_IMPORTANCE_MARKER, output)

    def test_backfills_explicit_action_items_from_transcript_when_model_has_none(self):
        transcript = (
            "Alex will send the revised deck by Friday. "
            "Jordan needs to confirm room booking before noon."
        )
        raw_summary = "Summary:\nThe team aligned on next steps.\n\nAction Items: none."

        output = finalize_summary_output(raw_summary, transcript)

        self.assertIn("- Alex will send the revised deck by Friday", output)
        self.assertIn("- Jordan needs to confirm room booking before noon", output)
        self.assertNotIn("Action Items: none.", output)

    def test_rejects_fragmentary_non_action_bullets(self):
        transcript = (
            "The event support that we need isn't as nailed down as it needs to be. "
            "I probably should have added it, but I did not. "
            "We also discussed roadmap visibility."
        )
        raw_summary = (
            "Summary:\n"
            "The team discussed product announcements and event planning.\n\n"
            "Action Items:\n"
            "- The event support that we need isn't as nailed down as it needs to be\n"
            "- I probably should have added it, but\n"
            "- But also because our roadmap is public, a new feature will come out\n"
        )

        output = finalize_summary_output(raw_summary, transcript)

        self.assertIn("Action Items: none.", output)

    def test_extracts_explicit_request_style_action_items_from_transcript(self):
        transcript = (
            "Get the commitment specifically from your campaign managers. "
            "Can you comment on the issue that yes I can commit to this."
        )
        raw_summary = "Summary:\nThe team discussed event planning.\n\nAction Items: none."

        output = finalize_summary_output(raw_summary, transcript)

        self.assertIn("- Get the commitment specifically from your campaign managers", output)
        self.assertIn("- Please comment on the issue that yes I can commit to this", output)

    def test_enriches_short_summary_with_followup_context_from_actions(self):
        transcript = (
            "The team discussed launch messaging for Commit. "
            "Get the commitment specifically from your campaign managers. "
            "We should reserve a spot for plan and aggregate the last 12 months."
        )
        raw_summary = (
            "Summary:\n"
            "The team aligned on launch messaging for Commit.\n\n"
            "Action Items:\n"
            "- Get the commitment specifically from your campaign managers\n"
            "- We should reserve a spot for plan and aggregate the last 12 months\n"
        )

        output = finalize_summary_output(raw_summary, transcript)
        summary_body = extract_summary_body(output)
        self.assertTrue(
            "Agreed follow-ups include" in summary_body
            or "reserve a spot for plan" in summary_body.lower()
            or "commitment specifically from your campaign managers" in summary_body.lower()
        )
        self.assertGreaterEqual(count_summary_sentences(output), 2)

    def test_non_actionable_transcript_returns_none(self):
        transcript = "The team introduced themselves and discussed background context."
        raw_summary = "Summary:\nThe team introduced themselves.\n\nAction Items: none."

        output = finalize_summary_output(raw_summary, transcript)

        self.assertIn("Action Items: none.", output)

    def test_caps_summary_sentence_count(self):
        transcript = (
            "Sentence one. Sentence two. Sentence three. "
            "Sentence four. Sentence five. Sentence six."
        )
        raw_summary = (
            "Summary:\n"
            "Sentence one. Sentence two. Sentence three. "
            "Sentence four. Sentence five. Sentence six.\n\n"
            "Action Items: none."
        )

        output = finalize_summary_output(raw_summary, transcript)
        self.assertLessEqual(count_summary_sentences(output), 4)


if __name__ == "__main__":
    unittest.main()
