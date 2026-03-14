import unittest

from backend.summary_formatting import (
    ACTION_ITEMS_MARKER,
    HIGH_IMPORTANCE_MARKER,
    SUMMARY_MARKER,
    contains_high_importance_language,
    count_summary_sentences,
    extract_summary_body,
    finalize_action_items_output,
    finalize_summary_output_model_first,
    finalize_summary_output,
    finalize_summary_output_explicit_actions,
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

    def test_rejects_ambiguous_take_that_action_items(self):
        transcript = (
            "I'm going to take that in a different semester because of the schedule conflict. "
            "The student needs to drop meteorology in order to add avionics."
        )
        raw_summary = (
            "Summary:\n"
            "The meeting covered a course schedule change.\n\n"
            "Action Items:\n"
            "- I'm going to take that in a different semester because of the schedule conflict\n"
            "- Student: needs to drop meteorology in order to add avionics"
        )

        output = finalize_summary_output_model_first(raw_summary, transcript)

        self.assertNotIn("take that in a different semester", output.lower())
        self.assertIn("- Student: needs to drop meteorology in order to add avionics", output)

    def test_strips_trailing_none_from_action_item_text(self):
        transcript = (
            "The student needs one more class to reach full-time status. "
            "The advisor suggested Old Testament survey."
        )
        raw_summary = (
            "Summary:\n"
            "The meeting focused on getting the student to full-time enrollment.\n\n"
            "Action Items:\n"
            "- Confirm the student's schedule and add one more class to make them full-time. none"
        )

        output = finalize_summary_output_model_first(raw_summary, transcript)

        self.assertIn("- Confirm the student's schedule and add one more class to make them full-time", output)
        self.assertNotIn("full-time. none", output)

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

    def test_model_first_summary_backfills_missing_detail_when_too_thin(self):
        transcript = (
            "The advisor and student reviewed the semester schedule after the student did not finish modern avionics last term. "
            "They decided the student should drop meteorology to add modern avionics. "
            "Modern avionics conflicts with chapel, so it may need to be taken in a different semester. "
            "The advisor asked the student to email JR Riggs to confirm the Flight 117 wait list."
        )
        raw_summary = (
            "Summary:\n"
            "The student should drop meteorology to add modern avionics.\n\n"
            "Action Items:\n"
            "- Student: email JR Riggs to confirm the Flight 117 wait list."
        )

        output = finalize_summary_output_model_first(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertIn("meteorology", summary_body)
        self.assertTrue("chapel" in summary_body or "wait list" in summary_body)
        self.assertGreaterEqual(count_summary_sentences(output), 2)

    def test_finalize_action_items_output_filters_placeholder_and_recovers_from_transcript(self):
        transcript = (
            "Student will send the updated schedule by Friday. "
            "Coach will follow up with the student next week."
        )
        raw_summary = (
            "Summary:\n"
            "speaker2 confirmed schedule updates and1 planning detail.\n\n"
            "Action Items:\n"
            "- Owner: Jr Topic: provide copy updated Due Date: TBD"
        )

        output = finalize_action_items_output(raw_summary, transcript)

        self.assertIn("Speaker 2 confirmed schedule updates and 1 planning detail.", output)
        self.assertIn("student: will send the updated schedule by friday", output.lower())
        self.assertIn("follow up with the student next week", output.lower())
        self.assertNotIn("Due Date", output)
        self.assertNotIn("Owner:", output)

    def test_finalize_summary_output_explicit_actions_ignores_model_admin_action_hallucinations(self):
        transcript = (
            "Speaker 1 is considering replacing geoscience classes with modern avionics classes. "
            "Speaker 2 shared tutoring program details and office hour availability."
        )
        raw_summary = (
            "Summary:\n"
            "The participant is considering replacing geoscience classes with modern avionics classes.\n\n"
            "Action Items:\n"
            "- Schedule a meeting with the geoscience department\n"
            "- Send a follow-up email to leadership\n"
            "- Review details and provide feedback"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)

        self.assertIn("modern avionics classes", extract_summary_body(output).lower())
        self.assertIn("Action Items: none.", output)
        self.assertNotIn("Schedule a meeting", output)

    def test_finalize_summary_output_explicit_actions_recovers_only_explicit_commitments(self):
        transcript = (
            "Student will email the professor tonight about the avionics prerequisite. "
            "Coach will follow up Friday after checking tutoring availability."
        )
        raw_summary = (
            "Summary:\n"
            "The student discussed avionics prerequisites and tutoring options.\n\n"
            "Action Items:\n"
            "- Schedule a meeting with department\n"
            "- Send a follow-up email"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)

        self.assertIn("- Student: will email the professor tonight about the avionics prerequisite", output)
        self.assertIn("- coach: will follow up friday after checking tutoring availability", output.lower())
        self.assertNotIn("Schedule a meeting", output)

    def test_finalize_summary_output_explicit_actions_rejects_colloquial_repetition(self):
        transcript = (
            "Student is choosing between avionics and meteorology classes. "
            "Student needs to drop meteorology to add avionics."
        )
        raw_summary = (
            "Summary:\n"
            "I'm gonna take a class on avionics, but I'm gonna take a class on meteorology. "
            "I'm not sure if I should retake flight two, or if I should retake flight two.\n\n"
            "Action Items:\n"
            "- Have to drop meteorology in order to add avionics"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertNotIn("i'm gonna", summary_body)
        self.assertNotIn("not sure if i should retake flight two, or if i should retake flight two", summary_body)
        self.assertIn("avionics", summary_body)
        self.assertIn("- Student: needs to drop meteorology to add avionics", output)

    def test_action_item_normalizes_have_to_to_needs_to(self):
        transcript = "Student have to drop meteorology in order to add avionics."
        raw_summary = (
            "Summary:\n"
            "Student discussed course planning.\n\n"
            "Action Items:\n"
            "- Student: Have to drop meteorology in order to add avionics"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)

        self.assertIn("- Student: needs to drop meteorology in order to add avionics", output)

    def test_finalize_summary_output_explicit_actions_rejects_weak_okay_and_bare_modal_summary(self):
        transcript = (
            "Student is considering whether to retake Flight 2. "
            "Student needs to drop meteorology in order to add avionics."
        )
        raw_summary = (
            "Summary:\n"
            "The student should be okay with not retaking it. Have to drop meteorology in order to add avionics.\n\n"
            "Action Items:\n"
            "- Student: needs to drop meteorology in order to add avionics"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertNotIn("should be okay", summary_body)
        self.assertNotIn("have to drop", summary_body)
        self.assertIn("drop meteorology", summary_body)
        self.assertIn("- Student: needs to drop meteorology in order to add avionics", output)

    def test_finalize_summary_output_explicit_actions_rejects_weak_inferred_placeholders(self):
        transcript = (
            "Coach reviewed replacing the legacy networking lab with the cybersecurity lab. "
            "The cybersecurity lab conflicts with choir, so it fits better next term. "
            "The student needs to drop weather systems to add the cybersecurity lab. "
            "Coach asked the student to email the registrar to confirm the waitlist."
        )
        raw_summary = (
            "Summary:\n"
            "The plan was to replace the old lab with the new one. "
            "The class may need to be taken next term. "
            "The student should already be on the waitlist.\n\n"
            "Action Items:\n"
            "- Student: email the registrar to confirm the waitlist"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertNotIn("the plan was", summary_body)
        self.assertNotIn("the class may need", summary_body)
        self.assertNotIn("should already be on the waitlist", summary_body)
        self.assertIn("cybersecurity lab", summary_body)
        self.assertIn("weather systems", output.lower())

    def test_finalize_summary_output_explicit_actions_rejects_conversational_transcript_fragments(self):
        transcript = (
            "Coach said the cybersecurity lab fits better next term because of the choir conflict. "
            "Coach confirmed there is no reason to retake navigation systems because the prior grade already counts. "
            "The student needs to drop weather systems to add the cybersecurity lab."
        )
        raw_summary = (
            "Summary:\n"
            "The participant plans to take that in a different semester because of the schedule conflict. "
            "Oh, so there would be no reason to retake it. "
            "The student needs to drop weather systems to add the cybersecurity lab.\n\n"
            "Action Items:\n"
            "- Student: needs to drop weather systems to add the cybersecurity lab"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertNotIn("oh, so", summary_body)
        self.assertNotIn("take that", summary_body)
        self.assertNotIn("retake it", summary_body)
        self.assertIn("cybersecurity lab", summary_body)

    def test_finalize_summary_output_explicit_actions_rejects_optional_suggestion_sentences(self):
        transcript = (
            "Coach reviewed orientation requirements and transfer questions. "
            "The student needs to submit the transfer form before enrollment closes. "
            "Coach mentioned the student could ask the front desk to confirm orientation hours."
        )
        raw_summary = (
            "Summary:\n"
            "The student could ask the front desk to confirm orientation hours. "
            "The student needs to submit the transfer form before enrollment closes.\n\n"
            "Action Items:\n"
            "- Student: needs to submit the transfer form before enrollment closes"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertNotIn("could ask the front desk", summary_body)
        self.assertIn("submit the transfer form", summary_body)

    def test_finalize_summary_output_explicit_actions_rejects_low_signal_comparison_fragments(self):
        transcript = (
            "Coach compared two elective options. "
            "The student needs to submit the practicum request before Friday. "
            "Neither option changes the graduation timeline."
        )
        raw_summary = (
            "Summary:\n"
            "Neither of those classes are absolutely essential. "
            "The student needs to submit the practicum request before Friday.\n\n"
            "Action Items:\n"
            "- Student: needs to submit the practicum request before Friday"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertNotIn("neither of those classes", summary_body)
        self.assertIn("practicum request", summary_body)

    def test_finalize_summary_output_explicit_actions_reduces_summary_action_duplication(self):
        transcript = (
            "The student needs to drop weather systems to add the cybersecurity lab. "
            "The cybersecurity lab conflicts with choir, so it fits better next term. "
            "Coach asked the student to email the registrar to confirm the waitlist."
        )
        raw_summary = (
            "Summary:\n"
            "The student needs to drop weather systems to add the cybersecurity lab. "
            "The cybersecurity lab conflicts with choir, so it fits better next term.\n\n"
            "Action Items:\n"
            "- Student: needs to drop weather systems to add the cybersecurity lab\n"
            "- Student: email the registrar to confirm the waitlist"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertIn("conflicts with choir", summary_body)
        self.assertEqual(output.lower().count("drop weather systems to add the cybersecurity lab"), 1)

    def test_finalize_summary_output_explicit_actions_prefers_transcript_grounded_summary(self):
        transcript = (
            "Student needs to drop meteorology in order to add modern avionics this semester. "
            "Coach confirmed Flight 204 does not need to be retaken because the prior C- is passing."
        )
        raw_summary = (
            "Summary:\n"
            "Speaker 1 is seeking information about leadership orientation and geoscience replacement due to professor inability.\n\n"
            "Action Items:\n"
            "- Schedule a leadership meeting"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertIn("drop meteorology", summary_body)
        self.assertIn("modern avionics", summary_body)
        self.assertNotIn("professor inability", summary_body)
        self.assertNotIn("leadership orientation", summary_body)
        self.assertIn("- student: needs to drop meteorology in order to add modern avionics this semester", output.lower())

    def test_finalize_summary_output_explicit_actions_avoids_question_style_summary_sentences(self):
        transcript = (
            "Student asked whether aviation tutoring is available. "
            "Coach confirmed study groups are available through the aviation coordinator."
        )
        raw_summary = (
            "Summary:\n"
            "Do you know if aviation tutoring is available?\n\n"
            "Action Items: none."
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)
        summary_body = extract_summary_body(output)

        self.assertNotIn("?", summary_body)
        self.assertIn("aviation tutoring", summary_body.lower())

    def test_finalize_summary_output_explicit_actions_prefers_concrete_commitments_over_lets_review(self):
        transcript = (
            "Coach: Let's review this week. You are still missing two Algebra assignments and that can block exam eligibility by March 1. "
            "Student: I thought I had more time, but I can do both this week. "
            "Coach: We need Assignment 7 submitted tonight and Assignment 8 by Friday. "
            "Coach: This is high priority because if grades are not updated, you may be ineligible for next week's exam. "
            "Student: I will go to tutoring tomorrow after class. "
            "Coach: I'll check your gradebook Thursday morning and email your teacher if either assignment is still missing."
        )
        raw_summary = (
            "Summary:\n"
            "The student has missing Algebra work that may block exam eligibility.\n\n"
            "Action Items:\n"
            "- Coach: Let's review this week"
        )

        output = finalize_summary_output_explicit_actions(raw_summary, transcript)

        self.assertNotIn("Let's review this week", output)
        self.assertIn("tutoring tomorrow after class", output.lower())
        self.assertIn("check your gradebook thursday morning", output.lower())

    def test_finalize_summary_output_model_first_keeps_grounded_model_summary(self):
        transcript = (
            "Student wants to add modern avionics this semester. "
            "The 10:30 to 12 avionics section conflicts with chapel, so the student cannot add that section unless meteorology is dropped. "
            "Coach confirmed the private pilot ground class does not need to be retaken because the prior C- is passing."
        )
        raw_summary = (
            "Summary:\n"
            "The student wants to add modern avionics this semester. "
            "The 10:30 to 12 avionics section conflicts with chapel, so the student cannot add that section unless meteorology is dropped.\n\n"
            "Action Items: none."
        )

        output = finalize_summary_output_model_first(raw_summary, transcript)
        summary_body = extract_summary_body(output)

        self.assertIn("modern avionics", summary_body.lower())
        self.assertIn("conflicts with chapel", summary_body.lower())
        self.assertNotIn("1030 to 12 is when avionics is", summary_body.lower())

    def test_finalize_summary_output_model_first_prefers_general_summary_over_schedule_chatter(self):
        transcript = (
            "10:30 to 12 is when avionics is. "
            "Right now the student has chapel in that area. "
            "The student needs to drop meteorology in order to add avionics. "
            "That'd be flight 117, so that the student can get it started."
        )
        raw_summary = (
            "Summary:\n"
            "The discussion focused on adjusting the student's schedule to add avionics while resolving a course conflict.\n\n"
            "Action Items: none."
        )

        output = finalize_summary_output_model_first(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertIn("adjusting the student's schedule", summary_body)
        self.assertIn("add avionics", summary_body)
        self.assertNotIn("10:30 to 12", summary_body)
        self.assertNotIn("right now", summary_body)
        self.assertNotIn("flight 117", summary_body)
        self.assertIn("- Student: needs to drop meteorology in order to add avionics", output)

    def test_finalize_summary_output_model_first_backfills_detail_without_action_labeling(self):
        transcript = (
            "The team aligned on launch messaging. "
            "Alex will send the revised deck by Friday. "
            "Jordan needs to confirm room booking before noon."
        )
        raw_summary = (
            "Summary:\n"
            "The team aligned on launch messaging.\n\n"
            "Action Items: none."
        )

        output = finalize_summary_output_model_first(raw_summary, transcript)
        summary_body = extract_summary_body(output).lower()

        self.assertIn("launch messaging", summary_body)
        self.assertIn("alex will send the revised deck by friday", summary_body)
        self.assertIn("- Alex will send the revised deck by Friday", output)
        self.assertIn("- Jordan needs to confirm room booking before noon", output)
        self.assertNotIn("follow-up action", summary_body)


if __name__ == "__main__":
    unittest.main()
