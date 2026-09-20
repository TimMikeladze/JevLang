#lang racket/base
;; Development-only differential oracle for the template grammar file handlers
;; use, and for the merge that resumes a clarified session.
(require json jev/handlers jev/session)

(define template-cases
  (list (list "home/{room}/light" (hasheq 'room "kitchen"))
        (list "{action}:{target}" (hasheq 'action "act" 'target "lights-on"))
        (list "count={n} on={on} missing-nothing" (hasheq 'n 3 'on #t))
        (list "{list}" (hasheq 'list '("a" "b")))
        (list "{obj}" (hasheq 'obj (hasheq 'a 1)))
        (list "no placeholders" (hasheq))
        (list "{a-b?}" (hasheq '|a-b?| "yes"))))

(define (template-result entry)
  (with-handlers ([exn:fail? (lambda (e) (hasheq 'error #t))])
    (hasheq 'filled (fill-template (first entry) (second entry) 'oracle))))
(define (first xs) (car xs))
(define (second xs) (cadr xs))

(write-json
 (hasheq 'templates (map template-result template-cases)
         'missing (with-handlers ([exn:fail? (lambda (e) "error")])
                    (fill-template "{nope}" (hasheq 'room "kitchen") 'oracle))
         'merge-string (default-merge "turn the lights on" "Which room?" "the bedroom")
         'merge-object (default-merge (hasheq 'request "turn the lights on" 'rooms '("kitchen"))
                                      "Which room?" "the bedroom")))
