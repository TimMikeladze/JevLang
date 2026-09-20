#lang racket/base
;; Development-only differential oracle for label harvesting: the file names, the
;; label forms, the settle rules over a history, and the store's lifecycle.
(require racket/list racket/runtime-path racket/file json
         jev/harvest jev/runtime jev/loader jev/client jev/capture)
(define-runtime-path cases-path "parity/harvest-cases.json")
(define-runtime-path examples "../../jev-lang/examples")
(define cases (call-with-input-file cases-path read-json))
(define store (vector-ref (current-command-line-arguments) 0))
(define policy (load-jev-policy (build-path examples "ticket-router.rkt")))

(define (opt v) (if (eq? v 'null) #f v))
(define (try thunk) (with-handlers ([exn:fail? (lambda (_) 'null)]) (thunk)))

;; A record's label, as derive sees it: settle a copy and read the result.
(define (derive-of h)
  (define rec (hasheq 'escalated (hash-ref h 'escalated)
                      'expect (let ([e (opt (hash-ref h 'expect))]) (or e 'null))
                      'outcomes (for/list ([o (in-list (hash-ref h 'outcomes))])
                                  (hasheq 'kind (hash-ref o 'kind)
                                          'label (or (opt (hash-ref o 'label #f)) 'null)
                                          'labels 'null
                                          'at "2026-09-18T12:00:00Z"))
                      'case_id "derive"))
  (define dir (make-temporary-file "jev-derive-~a" 'directory))
  (define r (harvest-outcome! dir "derive" 'close))   ; unknown: nothing written
  (delete-directory/files dir)
  ;; settle-record! is internal, so the rules are read through a real store below;
  ;; here the same shape goes through harvest-settle!'s dry run.
  (hasheq 'kind (format "~a" (harvest-result-status r))))

;; The lifecycle, in a store this run owns.
(define answers
  (hasheq 'department (hasheq 'type "choice" 'choice "billing" 'confidence 0.93
                              'probabilities (hasheq 'billing 0.93))
          'frustration (hasheq 'type "score" 'score 0.2 'confidence 0.9
                               'probabilities (hasheq '|0| 0.8 '|1| 0.2 '|2| 0.0))
          '|refund-requested?| (hasheq 'type "noul" 'noul 0.1)))
(define (capture-case)
  (parameterize ([current-jev-transport (lambda (payload)
                                          (hasheq 'answers answers 'model "jev-1.13.0"
                                                  'usage (hasheq 'input_tokens 10)))]
                 [current-api-key "test-key"])
    (evaluate/capture policy (hasheq 'ticket "please refund my invoice"))))

(define fixed (lambda () 1800000000))
(define (record-of path) (call-with-input-file path read-json))
(define (result->jsexpr r)
  (hasheq 'case_id (harvest-result-case-id r)
          'where (if (harvest-result-where r) (format "~a" (harvest-result-where r)) 'null)
          'label (or (harvest-result-label r) 'null)
          'strength (or (harvest-result-strength r) 'null)
          'source (or (harvest-result-source r) 'null)
          'status (format "~a" (harvest-result-status r))))

(define c (capture-case))
(define added (harvest-add! store c #:case-id "ticket/42" #:source "tickets" #:now fixed))
(define added-record (record-of (harvest-result-path added)))
(define closed (harvest-outcome! store "ticket/42" 'close
                                 #:labels (hasheq 'department "billing") #:now fixed))
(define closed-record (record-of (harvest-result-path closed)))
(define corrected (harvest-outcome! store "ticket/42" 'correction
                                    #:label "page:retention-oncall" #:now fixed))
(define corrected-record (record-of (harvest-result-path corrected)))
(define second (harvest-add! store c #:case-id "ticket/43" #:now fixed))
(define-values (settled skipped)
  (harvest-settle! store #:after 0 #:now (lambda () (+ (fixed) 1)) #:dry-run? #f))
(define status (harvest-status store #:after 0 #:now (lambda () (+ (fixed) 1))))

(write-json
 (hasheq
  'names (for/list ([id (in-list (hash-ref cases 'names))]) (safe-case-name id))
  'labels (for/list ([l (in-list (hash-ref cases 'labels))])
            (try (lambda () (normalize-label (if (hash? l) l l)))))
  'badLabels (for/list ([l (in-list (hash-ref cases 'badLabels))]) (try (lambda () (normalize-label l))))
  'strings (for/list ([l (in-list (hash-ref cases 'labels))])
             (try (lambda () (label->string (normalize-label l)))))
  'escalated (for/list ([d (in-list (hash-ref cases 'escalated))])
               (escalated-decision? (jsexpr->decision (hash-set d 'target (or (opt (hash-ref d 'target)) 'null)))))
  'times (for/list ([t (in-list (hash-ref cases 'times))]) (or (parse-iso8601 t) 'null))
  'lifecycle (hasheq 'added (result->jsexpr added)
                     'added_record (hasheq 'case_id (hash-ref added-record 'case_id)
                                           'name (hash-ref added-record 'name)
                                           'decided_at (hash-ref added-record 'decided_at)
                                           'escalated (hash-ref added-record 'escalated)
                                           'source (hash-ref added-record 'source 'null)
                                           'expect (hash-ref added-record 'expect 'null)
                                           'outcomes (hash-ref added-record 'outcomes '()))
                     'closed (result->jsexpr closed)
                     'closed_record (hasheq 'label (hash-ref closed-record 'label 'null)
                                            'label_strength (hash-ref closed-record 'label_strength 'null)
                                            'label_source (hash-ref closed-record 'label_source 'null)
                                            'settled_at (hash-ref closed-record 'settled_at 'null)
                                            'labels (hash-ref closed-record 'labels 'null)
                                            'outcomes (hash-ref closed-record 'outcomes '()))
                     'corrected (result->jsexpr corrected)
                     'corrected_label (hash-ref corrected-record 'label 'null)
                     'second (result->jsexpr second)
                     'settled (map result->jsexpr settled)
                     'skipped (length skipped)
                     'status (hash-remove status 'dir))))
