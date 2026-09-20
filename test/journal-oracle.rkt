#lang racket/base
;; Development-only differential oracle for the journal: the same operation
;; script, run against the Racket in-memory and SQLite journals.
(require racket/list racket/runtime-path json jev/journal jev/journal-db)
(define-runtime-path ops-path "parity/journal-ops.json")
(define sqlite-path (vector-ref (current-command-line-arguments) 0))

(define (claim->jsexpr r)
  (cond [(eq? r 'new) "new"]
        [(eq? r 'running) "running"]
        [(vector? r) (hasheq 'status (vector-ref r 1) 'result (vector-ref r 2))]
        [else (format "~a" r)]))

(define (run j ops)
  (for/list ([entry (in-list ops)])
    (define op (first entry))
    (define args (second entry))
    (define (a i) (list-ref args i))
    (case op
      [("beginStep") (claim->jsexpr (journal-begin-step! j (a 0) (string->symbol (a 1)) (a 2)))]
      [("finishStep") (journal-finish-step! j (a 0) (a 1) (a 2) (a 3)) 'null]
      [("releaseStep") (journal-release-step! j (a 0)) 'null]
      [("claimCooldown") (journal-claim-cooldown! j (string->symbol (a 0)) (a 1) (a 2))]
      [("coolingDown") (journal-cooling-down? j (string->symbol (a 0)) (a 1) (a 2))]
      [("claimBudget") (journal-claim-budget! j (string->symbol (a 0)) (a 1) (a 2) (a 3) (a 4))]
      [("schedule") (journal-schedule! j (a 0) (a 1) (a 2)) 'null]
      [("takeDue") (for/list ([pair (in-list (journal-take-due! j (a 0)))])
                     (list (car pair) (cdr pair)))]
      [("cancel") (journal-cancel! j (a 0))]
      [("nextDue") (or (journal-next-due j) 'null)]
      [else (error 'journal-oracle "unknown op ~a" op)])))

(define ops (call-with-input-file ops-path read-json))
(define memory (run (memory-journal) ops))
(define durable (let ([j (sqlite-journal sqlite-path)]) (begin0 (run j ops) (journal-close! j))))
(write-json (hasheq 'memory memory 'sqlite durable))
