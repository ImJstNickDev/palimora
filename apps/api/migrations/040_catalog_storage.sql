-- Search predicates, sorting and facets are evaluated by OpenSearch. Application
-- lookups, projection updates and recovery use catalog_documents_pkey. Neither
-- index supports the substring predicate used by the personal library.
DROP INDEX catalog_metadata;
DROP INDEX catalog_title;
