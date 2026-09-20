#lang racket/base
;; Development-only differential oracle for the reference policies: their wire
;; questions, the state they build, and the decisions they make. The portable
;; product never loads Racket.
(require racket/runtime-path racket/list json jev/loader jev/runtime jev/record jev/mcp)
(define-runtime-path examples "../../jev-lang/examples")
(define (reference name) (load-jev-policy (build-path examples name)))

(define (choice-answer wire confidence ps)
  (hasheq 'type "choice" 'choice wire 'confidence confidence
          'probabilities (for/hasheq ([p (in-list ps)]) (values (string->symbol (car p)) (cdr p)))))
(define (score-answer level confidence ps)
  (hasheq 'type "score" 'score level 'confidence confidence
          'probabilities (for/hasheq ([p (in-list ps)] [i (in-naturals)])
                           (values (string->symbol (number->string i)) p))))
(define (noul-answer p) (hasheq 'type "noul" 'noul p))

(define dispute (reference "dispute-review.rkt"))
(define fanout (reference "triage-fanout.rkt"))
(define guardrails (reference "guardrails.rkt"))

(define dispute-input
  (hasheq 'claim "Card 4111111111111111 was charged twice; mail jane@example.com or call 415-555-0132"
          'amount 249.99
          'account-age-days 12
          'prior-disputes 0
          'merchant "Acme"
          'activity (list "login from 10.0.0.1" "refund requested")))

(define (verdict wire confidence)
  (choice-answer wire confidence
                 (list (cons "refund" (if (equal? wire "refund") confidence 0.1))
                       (cons "deny" (if (equal? wire "deny") confidence 0.1))
                       (cons "investigate" (if (equal? wire "investigate") confidence 0.1)))))

(define dispute-cases
  (list (list "auto-refund"
              (hasheq 'verdict (verdict "refund" 0.93)
                      'risk (score-answer 0.3 0.9 '(0.8 0.15 0.05))
                      'first-time? (noul-answer 0.9))
              #f)
        (list "repeat-disputer"
              (hasheq 'verdict (verdict "refund" 0.91)
                      'risk (score-answer 0.6 0.88 '(0.6 0.3 0.1))
                      'first-time? (noul-answer 0.2))
              #f)
        (list "strong-fraud"
              (hasheq 'verdict (verdict "deny" 0.95)
                      'risk (score-answer 1.8 0.9 '(0.05 0.2 0.75))
                      'first-time? (noul-answer 0.5))
              #f)
        (list "deny"
              (hasheq 'verdict (verdict "deny" 0.9)
                      'risk (score-answer 0.4 0.85 '(0.7 0.2 0.1))
                      'first-time? (noul-answer 0.5))
              #f)
        (list "investigate"
              (hasheq 'verdict (verdict "investigate" 0.88)
                      'risk (score-answer 0.9 0.8 '(0.3 0.5 0.2))
                      'first-time? (noul-answer 0.5))
              #f)
        (list "unstable-verdict"
              (hasheq 'verdict (verdict "refund" 0.6)
                      'risk (score-answer 0.4 0.9 '(0.7 0.2 0.1))
                      'first-time? (noul-answer 0.9))
              #f)
        (list "unstable-risk"
              (hasheq 'verdict (verdict "deny" 0.95)
                      'risk (score-answer 0.9 0.5 '(0.4 0.35 0.25))
                      'first-time? (noul-answer 0.5))
              #f)))

(define (fanout-answers department department-ps return shipping resolution)
  (hasheq 'department (choice-answer (car department) (cdr department) department-ps)
          'return-reason (choice-answer (car return) (cdr return)
                                        (list (cons (car return) (cdr return)) (cons "other" (- 1.0 (cdr return)))))
          'shipping-issue (choice-answer (car shipping) (cdr shipping)
                                         (list (cons (car shipping) (cdr shipping)) (cons "other" (- 1.0 (cdr shipping)))))
          'resolution (choice-answer (car resolution) (cdr resolution)
                                     (list (cons (car resolution) (cdr resolution)) (cons "other" (- 1.0 (cdr resolution)))))))

(define fanout-cases
  (list (list "documented-ambiguous-ticket"
              (fanout-answers (cons "returns" 0.39) '(("returns" . 0.6) ("billing" . 0.38) ("shipping" . 0.02))
                              (cons "wrong_size" 1.0) (cons "delayed" 0.53) (cons "exchange" 0.16))
              #f)
        (list "shipping-with-unclear-issue"
              (fanout-answers (cons "shipping" 0.9) '(("shipping" . 0.9) ("returns" . 0.05) ("billing" . 0.05))
                              (cons "wrong_size" 0.9) (cons "delayed" 0.4) (cons "information" 0.8))
              #f)
        (list "billing-only"
              (fanout-answers (cons "billing" 0.95) '(("billing" . 0.95) ("returns" . 0.03) ("shipping" . 0.02))
                              (cons "wrong_size" 0.2) (cons "delayed" 0.2) (cons "information" 0.9))
              #f)
        (list "department-unclear"
              (fanout-answers (cons "returns" 0.2) '(("returns" . 0.2) ("billing" . 0.4) ("shipping" . 0.4))
                              (cons "wrong_size" 0.9) (cons "delayed" 0.9) (cons "refund" 0.9))
              #f)))

(define (guard-answers jailbreak self-harm pii severity severity-confidence severity-ps)
  (hasheq 'jailbreak? (noul-answer jailbreak)
          'self-harm? (noul-answer self-harm)
          'pii-request? (noul-answer pii)
          'severity (score-answer severity severity-confidence severity-ps)))

(define guardrails-cases
  (list (list "self-harm-outranks-block"
              (guard-answers 0.9 0.8 0.1 1.5 0.9 '(0.1 0.3 0.6)) #f)
        (list "jailbreak-block"
              (guard-answers 0.9 0.1 0.1 1.5 0.9 '(0.1 0.3 0.6)) #f)
        (list "jailbreak-review"
              (guard-answers 0.6 0.1 0.1 0.5 0.9 '(0.6 0.3 0.1)) #f)
        (list "permissive-profile-passes-review"
              (guard-answers 0.8 0.1 0.1 0.5 0.9 '(0.6 0.3 0.1)) "permissive")
        (list "pii-serious-blocks"
              (guard-answers 0.1 0.1 0.8 2.0 0.9 '(0.05 0.15 0.8)) #f)
        (list "pii-review"
              (guard-answers 0.1 0.1 0.8 0.5 0.9 '(0.6 0.3 0.1)) #f)
        (list "pass"
              (guard-answers 0.1 0.1 0.1 0.2 0.9 '(0.9 0.05 0.05)) #f)
        (list "severity-unclear"
              (guard-answers 0.1 0.1 0.8 1.0 0.3 '(0.3 0.4 0.3)) #f)))

(define (rows p cases)
  (for/list ([c (in-list cases)])
    (hasheq 'name (car c) 'answers (cadr c)
            'profile (or (caddr c) 'null)
            'decision (decision->jsexpr
                       (if (caddr c)
                           (policy-decide p (cadr c) #:profile (string->symbol (caddr c)))
                           (policy-decide p (cadr c)))))))

;; The smart-home policy is replayed over its real recorded answers.
(define home (reference "smart-home.rkt"))
(define home-fixtures
  (sort (fixture-paths (build-path examples "recorded" "smart-home")) string<?
        #:key (lambda (p) (path->string p))))
(define home-cases
  (for/list ([path (in-list home-fixtures)])
    (define f (read-fixture path))
    (hasheq 'name (fixture-name f)
            'answers (fixture-answers f)
            'facts (fixture-facts* f)
            'state (fixture-state f)
            'decision (decision->jsexpr (fixture-decide home f)))))

;; Token estimates: the fit against the real recorded usage, and the request
;; body the estimate is taken from.
(define home-input (hasheq 'request "lock the front door"))
(define home-state ((jev-policy-build-state home) home-input))
(define home-questions ((jev-policy-build-questions home) home-state))
(define home-body (hasheq 'state home-state 'model (jev-policy-model home) 'questions home-questions))
(define home-samples
  (for/list ([f (in-list (map read-fixture home-fixtures))]
             #:unless (fixture-synthetic f)
             #:when (let ([u (fixture-usage f)])
                      (and u (real? (hash-ref u 'input_tokens #f)) (positive? (hash-ref u 'input_tokens)))))
    (list (fixture-request-size f (jev-policy-questions home) (jev-policy-model home))
          (hash-ref (fixture-usage f) 'input_tokens))))
(define home-fit (fit-token-model (for/list ([s (in-list home-samples)]) (cons (first s) (second s)))))

(write-json
 (hasheq 'smart-home
         (hasheq 'identity (jev-policy-questions-sha256 home)
                 'schema (policy-actions->jsexpr home)
                 'cost (hasheq 'chars (string-length (jsexpr->string home-body))
                               'samples home-samples
                               'fit (hasheq 'n (token-fit-n home-fit)
                                            'intercept (token-fit-intercept home-fit)
                                            'slope (token-fit-slope home-fit)
                                            'spread (token-fit-spread home-fit)
                                            'lo (token-fit-lo home-fit)
                                            'hi (token-fit-hi home-fit))
                               'fitted_tokens (fit-tokens home-fit (string-length (jsexpr->string home-body)))
                               'rough_tokens (ceiling (/ (string-length (jsexpr->string home-body)) 4))
                               'usd (usage->cost (hasheq 'input_tokens (fit-tokens home-fit (string-length (jsexpr->string home-body))))))
                 'cases home-cases)
         'dispute-review
         (hasheq 'questions ((jev-policy-build-questions dispute) (hasheq))
                 'state ((jev-policy-build-state dispute) dispute-input)
                 'input dispute-input
                 'cases (rows dispute dispute-cases))
         'triage-fanout
         (hasheq 'questions ((jev-policy-build-questions fanout) (hasheq))
                 'cases (rows fanout fanout-cases))
         'guardrails
         (hasheq 'questions ((jev-policy-build-questions guardrails) (hasheq))
                 'cases (rows guardrails guardrails-cases))))
