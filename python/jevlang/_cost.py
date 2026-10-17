"""Token and cost estimates, with the honesty rules.

There is no public tokenizer. By default a token is ~4 characters of the
serialized JSON request body, which is good for an order of magnitude and
nothing more: on the recorded calls that default undercounted real charges by
about 2.2x. A fit against recorded usage replaces it with a straight line,
which is still an estimate, and only as good as the calls it came from.
"""
from __future__ import annotations

import math
from typing import Any

from ._common import is_object, require_at, finite
from ._state import state_size

# The characters a request body serializes to, counted in code points as the
# Racket implementation counts them.
chars = state_size


def request_body(state, model, questions) -> dict:
    return {'state': state, 'model': model, 'questions': questions}


def estimate_tokens(n: int) -> int:
    return math.ceil(n / 4)


ROUGH_ESTIMATOR = {'tokens': estimate_tokens, 'label': '~4 chars/token (rough estimate)'}


def fit_token_model(samples, min_n: int = 5):
    """A straight-line fit of tokens against request size, or None when there are
    too few samples or the fit is degenerate."""
    n = len(samples)
    if n < min_n:
        return None
    xs = [s[0] for s in samples]
    ys = [s[1] for s in samples]

    def mean(zs):
        return sum(zs) / len(zs)
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx > 1e-9:
        slope = sum((x - mx) * (ys[i] - my) for i, x in enumerate(xs)) / sxx
        intercept = my - slope * mx
    else:
        # Every request the same size: fit a rate through the origin.
        intercept = 0
        slope = sum(x * ys[i] for i, x in enumerate(xs)) / max(1e-9, sum(x * x for x in xs))
    spread = math.sqrt(sum(((intercept + slope * xs[i] - ys[i]) / max(ys[i], 1)) ** 2 for i in range(n)) / n)
    return ({'n': n, 'intercept': intercept, 'slope': slope, 'spread': spread,
             'lo': round(min(xs)), 'hi': round(max(xs))} if slope > 0 else None)


def fit_tokens(fit, n: int) -> int:
    return max(1, math.ceil(fit['intercept'] + fit['slope'] * n))


def fitted_estimator(fit) -> dict:
    plural = '' if fit['n'] == 1 else 's'
    return {'tokens': lambda n: fit_tokens(fit, n),
            'label': f"calibrated on {fit['n']} recorded call{plural}, +/- {round(100 * fit['spread'])}% (least-squares fit of input_tokens against request size, fitted on {fit['lo']} to {fit['hi']} chars; still an estimate)"}


def _part_tokens(estimator, body_chars: int, n: int) -> int:
    """Tokens for a part of a body, at the body's own rate, so the parts add up."""
    return 0 if body_chars == 0 else math.ceil(n * (estimator['tokens'](body_chars) / body_chars))


def samples_from_fixtures(policy, fixtures, model):
    identity = policy.identity()
    questions = policy.static_questions()
    samples = []
    for f in fixtures:
        usage = f.get('usage')
        if (f.get('assets') or f.get('fixture_version') == 4 or f.get('synthetic') is True or not is_object(usage) or not finite(usage.get('input_tokens'))
                or usage['input_tokens'] <= 0):
            continue
        recorded = (is_object(f.get('questions')) or f.get('questions_sha256') is None
                    or f['questions_sha256'].lower() == identity)
        if not recorded:
            continue
        state = f['state'] if is_object(f['state']) or isinstance(f.get('state'), str) else ''
        samples.append((chars(request_body(state, f.get('model') or model, f.get('questions') or questions)),
                        usage['input_tokens']))
    return samples


# The documented input price. Output is free; nothing here invents a price.
INPUT_PRICE_PER_MTOK = 0.042


def usage_cost(usage, price: float = INPUT_PRICE_PER_MTOK):
    input_tokens: Any = usage.get('input_tokens') if is_object(usage) else None
    return input_tokens * (price / 1e6) if finite(input_tokens) else None


# TODO(api): models.md gives 32k tokens for the state plus the longest question
# and 64k for the whole request; primitives.md says "around 32,000" shared.
STATE_AND_QUESTION_BUDGET = 32000
REQUEST_BUDGET = 64000


def _longest_question(questions) -> int:
    return max([0] + [chars(q) for q in questions.values()])


def budget_warnings(estimator, state_chars, questions, body_chars) -> list:
    both = _part_tokens(estimator, body_chars, state_chars + _longest_question(questions))
    total = estimator['tokens'](body_chars)
    warnings = []
    if both > STATE_AND_QUESTION_BUDGET:
        warnings.append(f'the state plus the longest question is about {both} tokens, over the {STATE_AND_QUESTION_BUDGET} models.md allows them (primitives.md says "around 32,000"). This is an estimate ({estimator["label"]}); shrink the state or add a maxChars cap.')
    if total > REQUEST_BUDGET:
        warnings.append(f'the whole request is about {total} tokens, over the {REQUEST_BUDGET} per request in models.md. This is an estimate ({estimator["label"]}).')
    return warnings


def cost(policy, input=None, fixtures=None, volume=1, model=None, price=INPUT_PRICE_PER_MTOK, assets=None, experimental=None) -> dict:
    require_at(isinstance(volume, int) and not isinstance(volume, bool) and volume > 0, 'volume',
               'volume must be a positive integer')
    from ._evaluate import policy_jev_options
    from ._assets import inspect_assets, asset_manifest
    options = policy_jev_options(policy.policy, {**({'assets': assets} if assets is not None else {}), **({'experimental': experimental} if experimental is not None else {})})
    built = policy.build_state(input, options) if input is not None else None
    state = built['state'] if built else ''
    questions = policy.questions(state) if built else policy.static_questions()
    chosen_model = model or policy.policy.get('model')
    images = inspect_assets(options.get('assets', {}), state, questions)
    if images:
        return {'mode': 'text only; image token total is unknown', 'note': 'No published image-token estimator; use reported input_tokens after a call.', 'model': chosen_model, 'assets': asset_manifest(images), 'image_tokens': None, 'text_tokens': estimate_tokens(chars(request_body(state, chosen_model, questions))), 'per_call': {'tokens': None, 'usd': None}, 'volume': {'calls': volume, 'tokens': None, 'usd': None}, 'input_price_per_mtok': price, 'warnings': ['Image cost is unreported until usage is returned.']}
    estimator = ROUGH_ESTIMATOR
    note = None
    if fixtures is not None:
        samples = samples_from_fixtures(policy, fixtures, chosen_model)
        fit = fit_token_model(samples)
        if fit:
            estimator = fitted_estimator(fit)
        else:
            synthetic = sum(1 for f in fixtures if f.get('synthetic') is True)
            plural = '' if len(samples) == 1 else 's'
            splural = '' if synthetic == 1 else 's'
            note = f"{len(samples)} usable recorded call{plural} (at least 5 needed; {synthetic} synthetic fixture{splural} ignored), so this uses the rough estimate"
    body_chars = chars(request_body(state, chosen_model, questions))
    question_tokens = _part_tokens(estimator, body_chars, chars(questions))
    state_tokens = _part_tokens(estimator, body_chars, chars(state)) if built else 0
    per_call = estimator['tokens'](body_chars)
    return {
        'mode': estimator['label'],
        'note': note,
        'model': chosen_model,
        'chars': body_chars,
        'questions_tokens': question_tokens,
        'state_tokens': state_tokens,
        'envelope_tokens': max(0, per_call - question_tokens - state_tokens),
        'per_call': {'tokens': per_call, 'usd': usage_cost({'input_tokens': per_call}, price)},
        'volume': {'calls': volume, 'tokens': per_call * volume,
                   'usd': usage_cost({'input_tokens': per_call * volume}, price)},
        'input_price_per_mtok': price,
        'warnings': budget_warnings(estimator, chars(state), questions, body_chars),
    }
