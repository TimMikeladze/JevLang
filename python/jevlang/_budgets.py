"""Conservative decimal model limits and separate text-context estimates."""
import math
from ._common import require_at
from ._numberfmt import jsonify


def model_limits(experimental=None):
    return {'question': 262000, 'request': 262000} if (experimental or {}).get('longContext') else {'question': 32000, 'request': 64000}


def check_request_budget(state, questions=None, options=None):
    questions, options = questions or {}, options or {}
    limits = model_limits(options.get('experimental'))
    question_limit = min(options.get('tokenLimit') or limits['question'], limits['question'])
    request_limit = min(options.get('requestTokenLimit') or limits['request'], limits['request'])
    size = lambda value: len(jsonify(value))
    per_question = math.ceil((size(state) + max([0] + [size(q) for q in questions.values()])) / 4)
    per_request = math.ceil((size(state) + size(questions)) / 4)
    require_at(per_question <= question_limit, 'state', f'state plus one question is about {per_question} tokens, above the {question_limit} per-question limit (~4 chars/token, rough estimate)', 'Cap the state or explicitly enable long context.', 'state')
    require_at(per_request <= request_limit, 'questions', f'whole request is about {per_request} tokens, above the {request_limit} per-request limit (~4 chars/token, rough estimate)', 'Send fewer questions or explicitly enable long context.', 'state')
    return {'perQuestion': per_question, 'perRequest': per_request, 'limits': {'question': question_limit, 'request': request_limit}}
