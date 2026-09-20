#lang racket/base
;; Development-only differential oracle for the monitoring numbers: a summary of
;; many decisions, and the calibration table for per-question labels.
(require racket/list racket/runtime-path json jev/loader jev/runtime jev/record jev/monitor)
(define-runtime-path examples "../../jev-lang/examples")
(define-runtime-path calibration-cases "parity/calibration-cases.json")
(define p (load-jev-policy (build-path examples "ticket-router.rkt")))

(define files
  (append (fixture-paths (build-path examples "fixtures"))
          (fixture-paths (build-path examples "recorded"))
          (fixture-paths (build-path examples "labeled"))))
(define fixtures (sort (map read-fixture files) string<? #:key fixture-name))
(define decisions (for/list ([f (in-list fixtures)]) (fixture-decide p f)))

(define cases
  (for/list ([c (in-list (call-with-input-file calibration-cases read-json))])
    (cons (hash-ref c 'answers) (hash-ref c 'labels))))

(write-json
 (hasheq 'names (map fixture-name fixtures)
         'from-answers (summary->jsexpr (summarize decisions
                                                   #:answers (map fixture-answers fixtures)
                                                   #:labels (map fixture-label fixtures)))
         'from-readings (summary->jsexpr (summarize decisions))
         'calibration (map calibration->jsexpr (calibrate cases))))
