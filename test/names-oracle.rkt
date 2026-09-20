#lang racket/base
;; Development-only differential oracle for option code names, wire keys, named
;; score levels and raw questions. Never loaded by the portable product.
(require racket/runtime-path json jev/loader jev/runtime)
(define-runtime-path policy-path "parity/names.rkt")
(define p (load-jev-policy policy-path))

(define (choice-answer wire confidence)
  (hasheq 'type "choice" 'choice wire 'confidence confidence
          'probabilities (hasheq (string->symbol wire) confidence)))
(define (score-answer level confidence ps)
  (hasheq 'type "score" 'score level 'confidence confidence
          'probabilities (for/hasheq ([p (in-list ps)] [i (in-naturals)])
                           (values (string->symbol (number->string i)) p))))
(define (noul-answer p) (hasheq 'type "noul" 'noul p))

(define cases
  (list
   (cons "urgent-transfer"
         (hasheq 'intent (choice-answer "approve_transfer" 0.93)
                 'urgency (score-answer 1.9 0.88 '(0.05 0.2 0.75))
                 'sentiment (noul-answer 0.82)))
   (cons "queued-transfer"
         (hasheq 'intent (choice-answer "approve_transfer" 0.91)
                 'urgency (score-answer 0.4 0.9 '(0.7 0.25 0.05))
                 'sentiment (noul-answer 0.1)))
   (cons "fast-balance"
         (hasheq 'intent (choice-answer "check-balance" 0.97)
                 'urgency (score-answer 1.2 0.8 '(0.2 0.5 0.3))
                 'sentiment (noul-answer 0.3)))
   (cons "self-serve"
         (hasheq 'intent (choice-answer "check-balance" 0.96)
                 'urgency (score-answer 0.2 0.85 '(0.85 0.1 0.05))
                 'sentiment (noul-answer 0.2)))
   (cons "other"
         (hasheq 'intent (choice-answer "other request" 0.85)
                 'urgency (score-answer 0.5 0.75 '(0.6 0.3 0.1))
                 'sentiment (noul-answer 0.4)))
   (cons "gate-intent"
         (hasheq 'intent (choice-answer "approve_transfer" 0.52)
                 'urgency (score-answer 1.9 0.9 '(0.05 0.2 0.75))
                 'sentiment (noul-answer 0.5)))
   (cons "gate-urgency"
         (hasheq 'intent (choice-answer "check-balance" 0.95)
                 'urgency (score-answer 1.0 0.41 '(0.3 0.4 0.3))
                 'sentiment (noul-answer 0.5)))))

(write-json
 (hasheq 'questions ((jev-policy-build-questions p) (hasheq 'request "the request text"))
         'cases (for/list ([c (in-list cases)])
                  (hasheq 'name (car c) 'answers (cdr c)
                          'decision (decision->jsexpr (policy-decide p (cdr c)))))))
