class ApplicationJob < ActiveJob::Base
  # Deadlocked rows and a database that is briefly gone are worth waiting for; a
  # record that has been deleted is not, and retrying a job about one forever is how
  # a queue fills with work nobody wants done.
  retry_on ActiveRecord::Deadlocked
  discard_on ActiveJob::DeserializationError
end
