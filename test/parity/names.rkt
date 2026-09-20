#lang jev
;; Development-only parity policy for the portable engine: option code names and
;; wire keys, named score levels, a raw question, and an extra request body.

(state request)

(choice intent
  #:ask "What is the user asking to do?"
  [check-balance "Check an account balance"]
  [approve-transfer #:key "approve_transfer" "Approve the pending transfer"]
  ["other request" "Anything else"])

(score urgency
  #:ask "How urgent is the request?"
  ([calm "No time pressure"] [soon "Wants it today"] [now "Needs it immediately"]))

(raw-question sentiment (object [type "noul"] [instructions "Is the customer upset?"]))

(extra-body (object [trace "portable-parity"]))

(escalate-below
  [intent  0.80 (escalate 'human #:reason "unclear intent")]
  [urgency 0.70 (escalate 'human #:reason "unclear urgency")])

(route
  [(and (is intent 'approve-transfer) (most-likely urgency 'now))
   (page 'transfer-desk #:reason "urgent transfer approval"
         #:data (hasheq 'wire (chosen intent) 'code (value-of intent)
                        'upset (hash-ref (raw-answer sentiment) 'noul 'null)))]
  [(is intent 'approve-transfer)
   (assign 'transfer-queue #:data (hasheq 'wire (chosen intent) 'code (value-of intent)))]
  [(and (is intent "check-balance") (at-least urgency 'soon)) (assign 'balance-fast)]
  [(is intent 'check-balance) (assign 'self-serve)]
  [(is intent "other request") (hold #:reason "nothing to route")])
