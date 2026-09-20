#lang racket/base
;; Development-only differential oracle for the policy/provider bridge: the
;; answer schema a policy's questions require, and the prompt that carries them.
(require racket/runtime-path json jev/loader jev/runtime jev/provider-backend)
(define-runtime-path examples "../../jev-lang/examples")
(define (reference name) (load-jev-policy (build-path examples name)))

(define ticket (reference "ticket-router.rkt"))
(define home (reference "smart-home.rkt"))
(define home-state ((jev-policy-build-state home) (hasheq 'request "lock the front door")))
(define home-questions ((jev-policy-build-questions home) home-state))
(define ticket-questions (jev-policy-questions ticket))

(write-json
 (hasheq 'ticket (hasheq 'schema (questions->answer-schema ticket-questions)
                         'prompt (generic-policy-prompt (hasheq 'ticket "a ticket") ticket-questions))
         'smart-home (hasheq 'schema (questions->answer-schema home-questions)
                             'prompt (generic-policy-prompt home-state home-questions))))
