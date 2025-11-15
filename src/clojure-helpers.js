/*global module*/

/**
 * Clojure helper functions to inject into nREPL session
 * These functions are available during code execution for discovery
 * Similar to code-mode's __interfaces and __getToolInterface
 */

/**
 * Get the Clojure code for helper functions
 * These will be evaluated in the nREPL session to make discovery functions available
 */
function getHelperFunctionsCode() {
    return `
;; Helper functions for namespace and function discovery
;; These are injected into the nREPL session for use during code execution

(defn list-namespaces
  "List all loaded namespaces in the Clojure runtime"
  []
  (sort (map str (keys (all-ns)))))

(defn get-ns-docs
  "Get documentation for a namespace"
  [ns-name]
  (try
    (require (symbol ns-name))
    (let [ns-obj (find-ns (symbol ns-name))
          ns-doc (-> ns-obj meta :doc)
          public-vars (ns-publics (symbol ns-name))
          functions (map (fn [[name var]]
                           {:name (str name)
                            :doc (-> var meta :doc)
                            :arglists (-> var meta :arglists)
                            :file (-> var meta :file)
                            :line (-> var meta :line)})
                         public-vars)]
      {:namespace ns-name
       :doc ns-doc
       :functions (sort-by :name functions)})
    (catch Exception e
      {:error (.getMessage e)})))

(defn search-functions
  "Search for functions matching a query string"
  [query]
  (let [query-lower (.toLowerCase query)
        all-nss (all-ns)
        results (atom [])]
    (doseq [ns all-nss]
      (try
        (require ns)
        (doseq [[name var] (ns-publics ns)]
          (let [name-str (str name)
                name-lower (.toLowerCase name-str)
                doc-str (or (-> var meta :doc) "")
                doc-lower (.toLowerCase doc-str)]
            (when (or (.contains name-lower query-lower)
                      (.contains doc-lower query-lower))
              (swap! results conj
                     {:namespace (str ns)
                      :name name-str
                      :doc (-> var meta :doc)
                      :arglists (-> var meta :arglists)}))))
        (catch Exception e nil)))
    (sort-by (juxt :namespace :name) @results)))

(defn get-fn-signature
  "Get signature and documentation for a function"
  [fn-name]
  (try
    (let [var-obj (resolve (symbol fn-name))
          meta-info (when var-obj (meta var-obj))]
      (when meta-info
        {:name fn-name
         :doc (:doc meta-info)
         :arglists (:arglists meta-info)
         :file (:file meta-info)
         :line (:line meta-info)
         :column (:column meta-info)}))
    (catch Exception e
      {:error (.getMessage e)})))

;; Make helpers available in user namespace
(require '[clojure.string :as str])
`.trim();
}

module.exports = {
    getHelperFunctionsCode: getHelperFunctionsCode
};

