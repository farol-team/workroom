require "test_helper"

# Puma's Solid Queue plugin does not check that the queue it supervises exists.
# It starts, queries `solid_queue_processes`, gets a missing table, and takes
# Puma down with it — so the failure is not "background work does not run", it
# is "the server does not boot", and only in the environment configured to start
# it. Deployed once, found the hard way.
class QueueConfigTest < ActiveSupport::TestCase
  ROOT   = Rails.root
  DEPLOY = YAML.load_file(ROOT.join("config/deploy.yml"), aliases: true)

  test "a queue is only started where there is a queue to start" do
    return unless DEPLOY.dig("env", "clear", "SOLID_QUEUE_IN_PUMA").to_s == "true"

    assert ROOT.join("db/queue_schema.rb").exist?,
      "Puma is told to run Solid Queue, but no db/queue_schema.rb defines its tables"

    db = YAML.load_file(ROOT.join("config/database.yml"), aliases: true)
    assert db.fetch("production").key?("queue"),
      "Puma is told to run Solid Queue, but production has no queue database for it to use"
  end

  # This used to assert that nothing enqueues anything, which was the honest state
  # until #304: a turn that runs on this server is minutes long and a request is not.
  # The question the gate exists to ask has not changed — it is still "does the queue
  # this application relies on actually exist" — only the direction it is asked from.
  test "what enqueues work has a queue to enqueue into" do
    enqueuing = Dir[ROOT.join("app/**/*.rb"), ROOT.join("lib/**/*.rb")]
      .reject { |f| f.end_with?("application_job.rb") }
      .select { |f| File.read(f).match?(/\bperform_later\b|\bdeliver_later\b/) }
    return if enqueuing.empty?

    assert ROOT.join("db/queue_schema.rb").exist?,
      "#{enqueuing.size} file(s) enqueue work, but no db/queue_schema.rb defines the tables for it"

    db = YAML.load_file(ROOT.join("config/database.yml"), aliases: true)
    %w[development production].each do |env|
      assert db.fetch(env).key?("queue"),
        "#{env} enqueues work and has no queue database for it to go into"
    end
  end
end
