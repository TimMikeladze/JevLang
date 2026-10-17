import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from jevlang import (Policy, JevError, choice, score, noul, noul_each, raw_question, gate, rule, assign, escalate, page, hold,
                 all_of, not_, fact, act, confirm, schedule, clarify, plan_for, branch, variable, threshold, literal,
                 record, compute, choose, array, eq)

ROOT = Path(__file__).resolve().parents[2]


def ticket_policy():
    department = choice("department", "Which team should handle this ticket?", {
        "billing": "Payments, invoicing, refunds, payouts, card failures",
        "technical": "Bugs, outages, API errors, integration problems",
        "sales": "Pricing, upgrades, quotas, new accounts",
    })
    frustration = score("frustration", "How frustrated is the customer?", [
        "Calm and matter-of-fact", "Annoyed but polite", "Angry, threatening to leave",
    ])
    refund = noul("refund-requested?", "Is the customer asking for money back?", criteria={
        "true": "Explicitly asks for a refund, credit, or chargeback",
        "false": "No mention of getting money back",
    })
    return Policy(name="ticket-router", questions=[department, frustration, refund], state={"ticket": {"path": []}}, gates=[
        gate(department, 0.8, escalate("human-triage", reason="unclear which team owns this")),
        gate(frustration, 0.7, escalate("human-triage", reason="unclear how upset they are")),
    ], route={"clauses": [
        rule(all_of(refund.yes(0.8), frustration.most_likely("Angry, threatening to leave")), page("retention-oncall", reason="angry refund request")),
        rule(department.is_("billing"), assign("billing-queue")),
        rule(department.is_("technical"), assign("engineering-oncall")),
        rule(department.is_("sales"), assign("sales-inbox")),
    ]})


def names_policy():
    """The Python mirror of jevlang/test/parity/names.js and its Racket oracle."""
    intent = choice("intent", "What is the user asking to do?", [
        {"key": "check-balance", "description": "Check an account balance"},
        {"name": "approve-transfer", "key": "approve_transfer", "description": "Approve the pending transfer"},
        {"key": "other request", "description": "Anything else"},
    ])
    urgency = score("urgency", "How urgent is the request?", [
        {"name": "calm", "level": "No time pressure"},
        {"name": "soon", "level": "Wants it today"},
        {"name": "now", "level": "Needs it immediately"},
    ])
    sentiment = raw_question("sentiment", {"type": "noul", "instructions": "Is the customer upset?"})
    return Policy(
        name="names", questions=[intent, urgency, sentiment], state={"request": {}},
        extraBody={"trace": "portable-parity"},
        gates=[
            gate(intent, 0.8, escalate("human", reason="unclear intent")),
            gate(urgency, 0.7, escalate("human", reason="unclear urgency")),
        ],
        route={"clauses": [
            rule(all_of(intent.is_("approve-transfer"), urgency.most_likely("now")),
                 page("transfer-desk", reason="urgent transfer approval",
                      data=record({"wire": intent.chosen(), "code": intent.value(),
                                   "upset": compute("get", sentiment.raw(), "noul", None)}))),
            rule(intent.is_("approve-transfer"),
                 assign("transfer-queue", data=record({"wire": intent.chosen(), "code": intent.value()}))),
            rule(all_of(intent.is_("check-balance"), urgency.at_least("soon")), assign("balance-fast")),
            rule(intent.is_("check-balance"), assign("self-serve")),
            rule(intent.is_("other request"), hold(reason="nothing to route")),
        ]})


def smart_home_policy():
    """The Python mirror of jevlang/examples/smart-home.js: typed actions, a family
    per room, a runtime choice of doors, an observed local fact, and plans."""
    category = choice("category", "What kind of request is `request`?", {
        "command": "An instruction to change something in the home: lights, doors, temperature",
        "conversation": "Small talk, or a question that needs a spoken answer rather than a device change",
        "other": "Something that fits neither",
    })
    lights = noul("lights?", "Does `request` ask to change any lights?")
    door_asked = noul("door?", "Does `request` ask to lock or unlock a door?")
    temperature = noul("temperature?", "Does `request` ask to make the home warmer or cooler?")
    lights_on_in = noul_each("lights-on-in", {"question": "Does `request` ask to turn on the lights in this room (or in every room)?"}, "rooms", itemKey="room")
    lights_off_in = noul_each("lights-off-in", {"question": "Does `request` ask to turn off the lights in this room (or in every room)?"}, "rooms", itemKey="room")
    door = choice("door", "If `request` is about a door, which door?", {"none": "Another door, or no door is named"}, optionsFrom="doors")
    lock_action = choice("lock-action", "If `request` is about a door, should it be locked or unlocked?", {
        "lock": "Lock it", "unlock": "Unlock it", "other": "Neither, or the request does not say"})
    temp_direction = choice("temp-direction", "If `request` is about temperature, which way should it go?", {
        "warmer": "Warmer", "cooler": "Cooler", "other": "Neither, or the request does not say"})
    delay = choice("delay", "When does `request` want it to happen?", {
        "now": "Now, or no time is given", "ten_min": "In about ten minutes", "thirty_min": "In about half an hour",
        "one_hour": "In about an hour", "other": "Some other time than these"})

    def command_about(q): return all_of(category.is_("command"), q.yes(threshold("asks-for")))
    def rooms_where(family): return choose(category.is_("command"), family.yes_items(threshold("room-named")), array())
    def any_room(family): return compute("gt", compute("length", rooms_where(family)), 0)

    def when_asked(d):
        return branch(delay.is_("now"), d,
                      branch(delay.is_("ten_min"), schedule(600, d),
                             branch(delay.is_("thirty_min"), schedule(1800, d),
                                    branch(delay.is_("one_hour"), schedule(3600, d),
                                           clarify("When should it happen?", delay)))))

    open_door = compute("contains", fact("open-doors"), door.chosen())
    return Policy(
        name="smart-home", version="2", owner="home", model="jev-1.14.0",
        questions=[category, lights, door_asked, temperature, lights_on_in, lights_off_in, door, lock_action, temp_direction, delay],
        state={
            "request": {"path": ["request"], "default": ""},
            "rooms": {"path": ["rooms"], "default": ["kitchen", "living_room", "bedroom"]},
            "doors": {"path": ["doors"], "default": ["front", "back", "garage"]},
            "open-doors": {"path": ["open-doors"], "default": [], "local": True},
        },
        thresholds={"asks-for": 0.7, "room-named": 0.9},
        actions={
            "lights-on": {"doc": "Turn a room's lights on", "params": {"room": {"type": "member-of", "field": "rooms"}}, "undo": act("lights-off", {"room": variable("room")})},
            "lights-off": {"doc": "Turn a room's lights off", "params": {"room": {"type": "member-of", "field": "rooms"}}, "undo": act("lights-on", {"room": variable("room")})},
            "lock-door": {"doc": "Lock a door", "params": {"door": {"type": "member-of", "field": "doors"}}, "timeout": 10},
            "unlock-door": {
                "doc": "Unlock a door. A resident approves every unlock.",
                "params": {"door": {"type": "member-of", "field": "doors"}},
                "confirm": True, "minConfidence": 0.9, "cooldown": 30, "allow": ["owner", "resident"], "timeout": 10,
                "undo": act("lock-door", {"door": variable("door")}),
            },
            "nudge-thermostat": {
                "doc": "Move the set point one step warmer or cooler; the handler does the arithmetic",
                "params": {"direction": {"type": "one-of", "values": ["warmer", "cooler"]}}, "cooldown": 60,
            },
        },
        gates=[
            gate(category, 0.6, escalate("ask-user", reason="not sure what kind of request this is"), onRead=True),
            gate(door, 0.8, escalate("ask-user", reason="which door?"), onRead=True),
            gate(lock_action, 0.8, escalate("ask-user", reason="lock or unlock?"), onRead=True),
            gate(temp_direction, 0.7, escalate("ask-user", reason="warmer or cooler?"), onRead=True),
            gate(delay, 0.7, escalate("ask-user", reason="when?"), onRead=True),
        ],
        route={
            "mode": "all",
            "clauses": [
                rule(any_room(lights_on_in), when_asked(plan_for("r", rooms_where(lights_on_in), act("lights-on", {"room": variable("r")})))),
                rule(any_room(lights_off_in), when_asked(plan_for("r", rooms_where(lights_off_in), act("lights-off", {"room": variable("r")})))),
                rule(all_of(command_about(lights), not_(any_room(lights_on_in)), not_(any_room(lights_off_in))), clarify("Which room?", lights_on_in)),
                rule(all_of(command_about(door_asked), not_(door.is_("none")), lock_action.is_("lock"), open_door),
                     hold(reason="that door is standing open; close it before locking")),
                rule(all_of(command_about(door_asked), not_(door.is_("none")), lock_action.is_("lock"), not_(open_door)),
                     when_asked(act("lock-door", {"door": door.chosen()}))),
                rule(all_of(command_about(door_asked), not_(door.is_("none")), lock_action.is_("unlock")),
                     confirm(act("unlock-door", {"door": door.chosen()}), reason="unlocking a door needs a resident's yes")),
                rule(all_of(command_about(temperature), not_(temp_direction.is_("other"))),
                     act("nudge-thermostat", {"direction": temp_direction.value()})),
                rule(category.is_("conversation"), assign("chat-model", reason="conversation: hand it to a language model")),
            ],
            "otherwise": hold(reason="nothing here the home can act on"),
        })



def extraction_policy():
    """The portable mirror of jev-lang/examples/extraction.rkt, as jevlang/examples/extraction.js writes it."""
    receipt_to = choice("receipt-to", "Which email address does the sender want their receipt sent to?",
                        {"none": "None of the listed addresses is the one they asked for"}, optionsFrom="addresses")
    credit = noul_each("credit?", {"question": "Is this amount a credit or refund to the customer, rather than a charge?"},
                       "amounts", itemKey="amount")
    return Policy(name="receipt-extraction", version="1", model="jev-1.14.0", questions=[receipt_to, credit],
                  state={"body": {"path": ["body"], "maxChars": 4000},
                         "addresses": {"path": ["addresses"]},
                         "amounts": {"path": ["amounts"]}},
                  stateOptions={"redact": ["phones", "cards", "keys"]},
                  thresholds={"credit-min": 0.7},
                  gates=[gate(receipt_to, 0.6, escalate("review", reason="unsure which address"))],
                  route={"clauses": [rule(receipt_to.is_("none"), escalate("review", reason="no candidate fits"))],
                         "otherwise": assign("send-receipt", data=record({
                             "to": receipt_to.chosen(), "credits": credit.count_yes(threshold("credit-min"))}))})


def alignment_policy(ungated=False):
    """Mirror the gated example; optionally exercise the older ungated behavior."""
    link = score("link", "Do `left` and `right` describe the same product?", [
        {"name": "different", "level": "They describe two different products."},
        {"name": "curator", "level": "They might be the same product; a person should check."},
        {"name": "same", "level": "They describe the same product."},
    ], **({"ungated": "the three levels are the three outcomes; the middle one is the review path"} if ungated else {}))
    same_name = noul("same-name?", "Do `left` and `right` give the same product name?")
    same_brewery = noul("same-brewery?", "Do `left` and `right` name the same brewery?")
    return Policy(name="entity-alignment", version="1" if ungated else "2", model="jev-1.14.0",
                  questions=[link, same_name, same_brewery],
                  gates=[] if ungated else [gate(link, 0.7, escalate("curator", reason="not sure these are the same product", show=[same_name, same_brewery]))],
                  state={"left": {"path": ["left"]}, "right": {"path": ["right"]}},
                  route={"clauses": [rule(eq(link.nearest(), "same"), assign("merge")),
                                     rule(eq(link.nearest(), "different"), assign("leave-unlinked"))],
                         "otherwise": escalate("curator", reason="might be the same product",
                                               show=[same_name, same_brewery])})


class LocalTests(unittest.TestCase):
    def test_real_and_synthetic_fixtures_offline(self):
        policy = ticket_policy()
        examples = Path(__file__).parent / "fixtures" / "legacy-examples"
        fixtures = [json.loads(f.read_text()) for folder in ("fixtures", "recorded") for f in sorted((examples / folder).glob("*.json"))]
        results = policy.replay(fixtures)
        self.assertGreaterEqual(len(results), 11)
        self.assertTrue(all(row["status"] == "pass" for row in results), results)
        self.assertTrue(all(row["fingerprintVerified"] for row in results))

    def _typescript_artifact(self, module: Path):
        node = shutil.which(os.environ.get("JEV_NODE", "node"))
        if node is None:
            self.skipTest("comparing artifacts with the TypeScript builders needs Node")
        result = subprocess.run([node, "--input-type=module", "-e", "import {policy} from " + json.dumps(module.as_uri()) + "; console.log(JSON.stringify(policy.toJSON()));"], capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_typescript_and_python_artifacts_are_identical(self):
        self.assertEqual(ticket_policy().to_json(), self._typescript_artifact(ROOT / "examples" / "ticket-router.js"))
        self.assertEqual(names_policy().to_json(), self._typescript_artifact(ROOT / "test" / "parity" / "names.js"))
        self.assertEqual(smart_home_policy().to_json(), self._typescript_artifact(ROOT / "examples" / "smart-home.js"))

    def test_actions_families_and_plans_decide_offline(self):
        policy = smart_home_policy()
        fixtures = [json.loads(f.read_text()) for f in sorted((Path(__file__).parent / "fixtures" / "legacy-examples" / "recorded" / "smart-home").glob("*.json"))]
        rows = policy.replay(fixtures)
        self.assertEqual([row["status"] for row in rows], ["pass"] * 7, rows)
        self.assertTrue(all(row["fingerprintVerified"] and row["verifiedBy"] == "questions" for row in rows))

    def test_runtime_options_and_families_decide_from_python(self):
        policy = extraction_policy()
        self.assertEqual(policy.to_json(), self._typescript_artifact(ROOT / "examples" / "extraction.js"))
        body = ("Send it to jane@example.com or billing@acme.com. Charges $40.00 and a credit of $12.50. "
                "Call 415-555-0132, card 4111111111111111.")
        # The host finds the candidates, the way the Racket state form does.
        state = policy.build_state({"body": body, "addresses": ["jane@example.com", "billing@acme.com"],
                                   "amounts": ["$40.00", "$12.50"]})["state"]
        self.assertNotIn("415-555-0132", state["body"])
        self.assertIn("jane@example.com", state["body"])
        questions = policy.questions(state)
        self.assertEqual(sorted(questions), ["credit?--0", "credit?--1", "receipt-to"])
        self.assertEqual(questions["receipt-to"]["criteria"]["billing@acme.com"], None)
        decision = policy.decide({
            "receipt-to": {"type": "choice", "choice": "billing@acme.com", "confidence": 0.93,
                           "probabilities": {"billing@acme.com": 0.93, "jane@example.com": 0.05, "none": 0.02}},
            "credit?--0": {"type": "noul", "noul": 0.1},
            "credit?--1": {"type": "noul", "noul": 0.9},
        }, state=state)
        self.assertEqual(decision["target"], "send-receipt")
        self.assertEqual(decision["data"], {"to": "billing@acme.com", "credits": 1})

    def test_an_ungated_score_is_read_by_level_name(self):
        policy = alignment_policy(ungated=True)
        answers = lambda level: {
            "link": {"type": "score", "score": level, "confidence": 0.2, "probabilities": {"0": 0.3, "1": 0.3, "2": 0.4}},
            "same-name?": {"type": "noul", "noul": 0.95},
            "same-brewery?": {"type": "noul", "noul": 0.9},
        }
        # Low confidence never escalates: the question is declared ungated.
        self.assertEqual(policy.decide(answers(2.0))["target"], "merge")
        self.assertEqual(policy.decide(answers(0.0))["target"], "leave-unlinked")
        middle = policy.decide(answers(1.0))
        self.assertEqual(middle["target"], "curator")
        self.assertEqual([r["question"] for r in middle["evidence"]], ["same-name?", "same-brewery?"])

    def test_gated_alignment_matches_javascript_and_reviews_uncertainty(self):
        policy = alignment_policy()
        self.assertEqual(policy.to_json(), self._typescript_artifact(ROOT / "examples" / "entity-alignment.js"))
        answers = {"link": {"type": "score", "score": 2, "confidence": .2, "probabilities": {"0": .3, "1": .3, "2": .4}},
                   "same-name?": {"type": "noul", "noul": .95}, "same-brewery?": {"type": "noul", "noul": .9}}
        self.assertEqual(policy.decide(answers)["target"], "curator")
        answers["link"]["confidence"] = .9
        self.assertEqual(policy.decide(answers)["target"], "merge")

    def test_option_code_names_levels_and_raw_questions(self):
        policy = names_policy()
        decision = policy.decide({
            "intent": {"type": "choice", "choice": "approve_transfer", "confidence": 0.91, "probabilities": {"approve_transfer": 0.91}},
            "urgency": {"type": "score", "score": 1.9, "confidence": 0.88, "probabilities": {"0": 0.05, "1": 0.2, "2": 0.75}},
            "sentiment": {"type": "noul", "noul": 0.82},
        })
        self.assertEqual(decision["target"], "transfer-desk")
        # The policy reads the code name; the wire key is what was answered.
        self.assertEqual(decision["data"], {"wire": "approve_transfer", "code": "approve-transfer", "upset": 0.82})
        self.assertEqual([r["question"] for r in decision["readings"]], ["intent", "urgency"])
        self.assertEqual([w["path"] for w in policy.warnings], ["$.extraBody", "$.questions.sentiment"])
        with self.assertRaisesRegex(ValueError, "distinct keys"):
            choice("q", "Which?", ["a", "a"])
        with self.assertRaises(JevError):
            # A code name that is also another option's wire key means two things.
            Policy(name="clash", questions=[choice("q", "Which?", [{"name": "a", "key": "x"}, {"key": "a"}])],
                   route={"clauses": [], "otherwise": hold()})

    def test_schema_stats_and_calibration_are_offline(self):
        home = smart_home_policy()
        schema = home.schema()
        self.assertEqual(schema["policy"], "smart-home")
        unlock = next(a for a in schema["actions"] if a["name"] == "unlock-door")
        self.assertTrue(unlock["annotations"]["destructiveHint"])
        self.assertEqual(unlock["_meta"]["jev/allow"], ["owner", "resident"])
        self.assertEqual(unlock["inputSchema"]["required"], ["door"])

        examples = Path(__file__).parent / "fixtures" / "legacy-examples"
        fixtures = [json.loads(f.read_text()) for folder in ("fixtures", "recorded") for f in sorted((examples / folder).glob("*.json"))]
        report = ticket_policy().stats(fixtures)
        self.assertEqual(report["unusable"], 0)
        self.assertEqual(report["summary"]["total"], len(fixtures))
        self.assertEqual(report["summary"]["confidence"]["source"], "answers")

        home_fixtures = [json.loads(f.read_text()) for f in sorted((examples / "recorded" / "smart-home").glob("*.json"))]
        rough = home.cost(input={"request": "lock the front door"})
        calibrated = home.cost(input={"request": "lock the front door"}, fixtures=home_fixtures)
        self.assertIn("rough estimate", rough["mode"])
        self.assertIn("calibrated on 7 recorded calls", calibrated["mode"])
        # The 4 chars/token default undercounts the real charges on these calls.
        self.assertLess(rough["per_call"]["tokens"], calibrated["per_call"]["tokens"])
        self.assertEqual(calibrated["input_price_per_mtok"], 0.042)

        table = ticket_policy().calibrate([{**fixtures[0], "labels": {"department": "billing"}}])
        self.assertEqual(table[0]["question"], "department")
        self.assertFalse(table[0]["enough_labels"])

    def test_evaluate_and_record_through_a_local_provider(self):
        """No network: a fake executable answers the questions."""
        import shutil as _shutil
        if _shutil.which(os.environ.get("JEV_NODE", "node")) is None:
            self.skipTest("the fake answer provider is a Node script; the native evaluate path needs Node only to run it")
        directory = Path(tempfile.mkdtemp())
        executable = directory / "answer-provider"
        executable.write_text(
            "#!/usr/bin/env node\n"
            "let input = '';\n"
            "process.stdin.on('data', c => { input += c; });\n"
            "process.stdin.on('end', () => {\n"
            "  const request = JSON.parse(input);\n"
            "  const answers = {};\n"
            "  for (const [id, q] of Object.entries(request.metadata.questions)) {\n"
            "    if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { type: 'choice', choice: k, confidence: 0.95, probabilities: { [k]: 0.95 } }; }\n"
            "    else if (q.type === 'score') answers[id] = { type: 'score', score: 0, confidence: 0.95, probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === 0 ? 0.9 : 0.05])) };\n"
            "    else answers[id] = { type: 'noul', noul: 0.02 };\n"
            "  }\n"
            "  process.stdout.write(JSON.stringify({ output: answers, model: 'fake-answerer', usage: { input_tokens: 3 } }));\n"
            "});\n")
        executable.chmod(0o755)
        config = {"provider": "answerer", "providers": {"answerer": {"command": str(executable)}}}
        policy = ticket_policy()
        merged = {"_layers": [["project", config]], **config}
        decision = policy.evaluate({"ticket": "I want a refund"}, config=merged)
        self.assertEqual(decision["provider"], "answerer")
        self.assertEqual(decision["model"], "fake-answerer")
        self.assertIsNotNone(decision["target"])

        recorded = policy.record({"ticket": "I want a refund"}, config=merged, name="python-recorded")
        fixture = recorded["fixture"]
        self.assertEqual(fixture["fixture_version"], 3)
        self.assertEqual(fixture["provider"], "answerer")
        self.assertEqual(policy.replay([fixture])[0]["status"], "pass")

    def test_validation_errors_are_structured(self):
        q = choice("q", "Which?", ["a", "b"])
        with self.assertRaises(JevError) as error:
            Policy(name="invalid", questions=[q], route={"clauses": [rule(q.is_("typo"), hold())], "otherwise": hold()})
        self.assertEqual(error.exception.code, "validation")
        self.assertIn("$.route.clauses[0]", error.exception.path)
        self.assertIsNotNone(error.exception.fix)

    def test_expressions_cannot_be_python_control_flow(self):
        with self.assertRaisesRegex(TypeError, "policy data"):
            bool(choice("q", "Which?", ["a", "b"]).is_("a"))

    def test_literal_data_is_not_executed(self):
        policy = Policy(name="literal", route={"clauses": [], "otherwise": hold(data=literal({"op": "eval", "args": ["do not execute"]}))})
        self.assertEqual(policy.decide({})["data"]["op"], "eval")

    def test_policy_roundtrip_and_mutation_isolation(self):
        p = ticket_policy()
        raw = p.to_json()
        copy = Policy.from_json(raw)
        raw["name"] = "mutated"
        self.assertEqual(p.to_json(), copy.to_json())
        self.assertNotEqual(p.to_json()["name"], raw["name"])


if __name__ == "__main__":
    unittest.main()
