#lang racket/base
;; Development-only differential oracle for the remaining reference policies:
;; hello, ticket-router-v2 (on-read gates), entity-alignment (an ungated score
;; read by name) and extraction (runtime options and a noul family). The portable
;; product never loads Racket.
(require racket/runtime-path racket/list json jev/loader jev/runtime)
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

(define (case name answers) (list name answers))

;; hello: one noul, one branch.
(define hello (reference "hello.rkt"))
(define hello-cases
  (list (case "spam" (hasheq '|spam?| (noul-answer 0.97)))
        (case "unsure" (hasheq '|spam?| (noul-answer 0.5)))
        (case "inbox" (hasheq '|spam?| (noul-answer 0.02)))))

;; ticket-router-v2: the same questions as v1, with on-read gates.
(define v2 (reference "ticket-router-v2.rkt"))
(define (dept wire confidence)
  (choice-answer wire confidence
                 (list (cons "billing" (if (equal? wire "billing") confidence 0.05))
                       (cons "technical" (if (equal? wire "technical") confidence 0.05))
                       (cons "sales" (if (equal? wire "sales") confidence 0.05)))))
(define v2-cases
  (list (case "angry-refund"
              (hasheq 'department (dept "billing" 0.95)
                      'frustration (score-answer 1.9 0.9 '(0.05 0.2 0.75))
                      '|refund-requested?| (noul-answer 0.95)))
        ;; A certain team with an uncertain frustration: the on-read gate leaves
        ;; it alone, because the route never reads frustration.
        (case "certain-team-uncertain-mood"
              (hasheq 'department (dept "technical" 1.0)
                      'frustration (score-answer 1.0 0.4 '(0.3 0.4 0.3))
                      '|refund-requested?| (noul-answer 0.1)))
        ;; A refund request does read frustration, so its gate fires.
        (case "refund-uncertain-mood"
              (hasheq 'department (dept "billing" 0.95)
                      'frustration (score-answer 1.5 0.4 '(0.2 0.3 0.5))
                      '|refund-requested?| (noul-answer 0.9)))
        (case "unclear-team"
              (hasheq 'department (dept "sales" 0.5)
                      'frustration (score-answer 0.2 0.9 '(0.9 0.05 0.05))
                      '|refund-requested?| (noul-answer 0.1)))
        (case "sales"
              (hasheq 'department (dept "sales" 0.92)
                      'frustration (score-answer 0.3 0.88 '(0.8 0.15 0.05))
                      '|refund-requested?| (noul-answer 0.05)))))

;; entity-alignment: the level read by name, with nouls shown as evidence.
(define alignment (reference "entity-alignment.rkt"))
(define (link-answer level ps) (score-answer level 0.9 ps))
(define alignment-cases
  (list (case "merge" (hasheq 'link (link-answer 2.0 '(0.05 0.15 0.8))
                              '|same-name?| (noul-answer 0.95)
                              '|same-brewery?| (noul-answer 0.9)))
        (case "curator" (hasheq 'link (link-answer 1.2 '(0.2 0.5 0.3))
                                '|same-name?| (noul-answer 0.6)
                                '|same-brewery?| (noul-answer 0.8)))
        (case "leave-unlinked" (hasheq 'link (link-answer 0.1 '(0.9 0.07 0.03))
                                       '|same-name?| (noul-answer 0.1)
                                       '|same-brewery?| (noul-answer 0.2)))
        ;; An ungated question never escalates on low confidence.
        (case "low-confidence"
              (hasheq 'link (score-answer 2.0 0.2 '(0.3 0.3 0.4))
                      '|same-name?| (noul-answer 0.5)
                      '|same-brewery?| (noul-answer 0.5)))))
(define alignment-input (hasheq 'left "Hazy Little Thing IPA" 'right "Sierra Nevada Hazy Little Thing"))

;; extraction: runtime options from a state field, and a noul per amount.
(define extraction (reference "extraction.rkt"))
(define extraction-input
  (hasheq 'body (string-append "Send it to jane@example.com or billing@acme.com. "
                               "Charges $40.00 and a credit of $12.50. "
                               "Call 415-555-0132, card 4111111111111111.")))
(define extraction-state ((jev-policy-build-state extraction) extraction-input))
(define (address-answer wire confidence)
  (choice-answer wire confidence
                 (list (cons "jane@example.com" (if (equal? wire "jane@example.com") confidence 0.05))
                       (cons "billing@acme.com" (if (equal? wire "billing@acme.com") confidence 0.05))
                       (cons "none" (if (equal? wire "none") confidence 0.05)))))
(define extraction-cases
  (list (case "send" (hasheq '|receipt-to| (address-answer "billing@acme.com" 0.93)
                             '|credit?--0| (noul-answer 0.1)
                             '|credit?--1| (noul-answer 0.9)))
        (case "no-candidate" (hasheq '|receipt-to| (address-answer "none" 0.88)
                                     '|credit?--0| (noul-answer 0.2)
                                     '|credit?--1| (noul-answer 0.2)))
        (case "unsure-address" (hasheq '|receipt-to| (address-answer "jane@example.com" 0.4)
                                       '|credit?--0| (noul-answer 0.8)
                                       '|credit?--1| (noul-answer 0.8)))))

(define (rows policy cases)
  (for/list ([c (in-list cases)])
    (hasheq 'name (first c) 'answers (second c)
            'decision (decision->jsexpr (policy-decide policy (second c))))))

(write-json
 (hasheq
  'hello (hasheq 'questions ((jev-policy-build-questions hello) (hasheq))
                 'cases (rows hello hello-cases))
  'ticket-router-v2 (hasheq 'questions ((jev-policy-build-questions v2) (hasheq 'ticket "the ticket text"))
                            'state ((jev-policy-build-state v2) (hasheq 'ticket "the ticket text"))
                            'cases (rows v2 v2-cases))
  'entity-alignment (hasheq 'questions ((jev-policy-build-questions alignment) alignment-input)
                            'state ((jev-policy-build-state alignment) alignment-input)
                            'cases (rows alignment alignment-cases))
  'extraction (hasheq 'questions ((jev-policy-build-questions extraction) extraction-state)
                      'state extraction-state
                      'input extraction-input
                      'cases (rows extraction extraction-cases))))
