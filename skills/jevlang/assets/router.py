from jevlang import Policy, choice, gate, escalate, rule, assign

team = choice('team', 'Which team should handle this message?', {
    'billing': 'Charges, invoices, refunds',
    'technical': 'Bugs, outages, integration errors',
})

policy = Policy(
    name='support-router',
    questions=[team],
    state={'message': {'path': ['message'], 'maxChars': 4000}},
    gates=[gate(team, 0.8, escalate('human-triage', reason='Uncertain team'))],
    route={
        'clauses': [rule(team.is_('billing'), assign('billing-queue'))],
        'otherwise': assign('technical-queue'),
    },
)

if __name__ == '__main__':
    for confidence in [0.95, 0.55]:
        decision = policy.decide({'team': {'choice': 'billing', 'confidence': confidence}})
        print(decision['action'], decision['target'])
