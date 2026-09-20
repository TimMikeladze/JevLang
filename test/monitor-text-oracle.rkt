#lang racket/base
;; Development-only differential oracle for the parts of monitor.rkt a person
;; reads: the two-window comparison, and every text report.
;;
;; A clause's file, source text and line come from the host language, so they are
;; blanked on both sides before anything is formatted; everything else is
;; compared exactly, character for character.
(require racket/list racket/string racket/runtime-path json
         jev/loader jev/runtime jev/record jev/monitor)
(define-runtime-path examples "../../jev-lang/examples")
(define-runtime-path stability-cases "parity/stability-cases.json")
(define-runtime-path calibration-cases "parity/calibration-cases.json")
(define p (load-jev-policy (build-path examples "ticket-router.rkt")))

(define files
  (append (fixture-paths (build-path examples "fixtures"))
          (fixture-paths (build-path examples "recorded"))
          (fixture-paths (build-path examples "labeled"))))
(define fixtures (sort (map read-fixture files) string<? #:key fixture-name))
(define decisions (for/list ([f (in-list fixtures)]) (fixture-decide p f)))

;; Two windows: the first half of the fixtures against the second.
(define half (quotient (length decisions) 2))
(define window-a (take decisions half))
(define window-b (drop decisions half))

;; Blank what the host language owns.
(define (plain-clause c)
  (clause-count #f (clause-count-rule c) (clause-count-index c) #f #f (clause-count-count c)))
(define (plain s) (struct-copy summary s [clauses (map plain-clause (summary-clauses s))]))
(define (plain-shift s)
  (struct-copy clause-shift s [file #f] [source #f]))
(define (plain-comparison c)
  (struct-copy comparison c [shifts (map plain-shift (comparison-shifts c))]))

(define sa (plain (summarize window-a)))
(define sb (plain (summarize window-b)))
(define labelled (plain (summarize decisions
                                   #:answers (map fixture-answers fixtures)
                                   #:labels (map fixture-label fixtures))))
(define cmp (plain-comparison (compare window-a window-b)))

;; --- the stability statistics, over answers nobody had to call a provider for
(define cases (call-with-input-file stability-cases read-json))
(define (sym v) (and v (not (eq? v 'null)) (string->symbol v)))
(define (num v) (and (real? v) v))
(define gates
  (for/list ([g (in-list (hash-ref cases 'gates))])
    (define question (sym (hash-ref g 'question)))
    (define kind (sym (hash-ref g 'kind)))
    (define option (sym (hash-ref g 'option #f)))
    (hasheq 'question question
            'kind kind
            'name (if (eq? kind 'option-gate)
                      (string->symbol (format "~a/~a" question option))
                      question)
            'threshold (num (hash-ref g 'threshold #f))
            'by (sym (hash-ref g 'by #f))
            'option option
            'lo (num (hash-ref g 'lo #f))
            'hi (num (hash-ref g 'hi #f)))))
(define thresholds
  (for/list ([t (in-list (hash-ref cases 'thresholds))])
    (hasheq 'name (sym (hash-ref t 'name))
            'kind (sym (hash-ref t 'kind))
            'default (hash-ref t 'default))))
(define runs (hash-ref cases 'runs))
(define all-answers
  (for/list ([r (in-list runs)])
    (for/hasheq ([(k v) (in-hash (hash-ref r 'answers))]) (values k v))))
;; run-stability describes a decide that failed as "error" and keeps the message
;; in the report's errors, so this does the same.
(define (description r)
  (define d (hash-ref r 'decision))
  (if (string? d)
      "error"
      (string-append (hash-ref d 'action)
                     (let ([t (hash-ref d 'target #f)]) (if t (format " ~a" t) "")))))
(define descs (for/list ([r (in-list runs)]) (description r)))
(define tally
  (let ([h (for/fold ([h (hash)]) ([x (in-list descs)]) (hash-update h x add1 0))])
    (sort (sort (hash->list h) string<? #:key car) > #:key cdr)))
(define errors (for/list ([r (in-list runs)] #:when (string? (hash-ref r 'decision))) (hash-ref r 'decision)))
(define usage
  (let ([u (hash-ref cases 'usage)])
    (hasheq 'input_tokens (hash-ref u 'input_tokens) 'output_tokens (hash-ref u 'output_tokens))))
(define report
  (stability-report (hash-ref cases 'policy) (length runs) #t
                    (question-stabilities all-answers gates thresholds)
                    tally errors usage #f))

;; A precheck report has nothing to repeat, and says so instead of a table.
(define calm
  (hasheq 'department (hasheq 'type "choice" 'choice "billing" 'confidence 0.99
                              'probabilities (hasheq 'billing 0.99 'technical 0.005 'sales 0.005))
          'frustration (hasheq 'type "score" 'score 0.2 'confidence 0.95
                               'probabilities (hasheq '|0| 0.9 '|1| 0.07 '|2| 0.03))
          'refund-requested? (hasheq 'type "noul" 'noul 0.1)))
(define precheck-report
  (stability-report (hash-ref cases 'policy) 12 #f '() '() '() (hasheq 'input_tokens 0 'output_tokens 0)
                    ((policy-decider p) calm #f)))

(write-json
 (hasheq 'summary_a (summary->jsexpr sa)
         'summary_a_text (format-summary sa)
         'summary_labelled_text (format-summary labelled)
         'comparison (comparison->jsexpr cmp)
         'comparison_text (format-comparison cmp)
         'comparison_text_named (format-comparison cmp #:labels '("last week" "this week"))
         'calibration_text
         (for/list ([c (in-list (calibrate (for/list ([c (in-list (call-with-input-file calibration-cases read-json))])
                                             (cons (hash-ref c 'answers) (hash-ref c 'labels)))))])
           (format-calibration c))
         'stability (stability-report->jsexpr report)
         'stability_text (format-stability report)
         'precheck_text (format-stability precheck-report)
         'decimals (for/list ([x (in-list '(0.125 0.5 0.0005 33.333333 99.95 1.0005))])
                     (list (real->decimal-string x 1) (real->decimal-string x 3) (real->decimal-string x 6)))))
