ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"

module Build
  module_function

  # Every room belongs to one, and a record created with none in scope is a bug
  # rather than a default. A test that does not care which workspace it is in
  # gets this one; a test about workspaces makes its own.
  def workspace(slug: nil, name: "WorkRoom")
    Workspace.create!(slug: slug || "ws-#{SecureRandom.hex(3)}", name:)
  end

  def in_a_workspace = Current.workspace ||= workspace

  # A person, and their place in the room the test is in. After #134 nobody
  # reaches a workspace without a membership in it, so a fixture without one is
  # a person the product cannot produce.
  def user(name: "Alice", email: nil, workspace: nil)
    email ||= "#{name.downcase}-#{SecureRandom.hex(3)}@example.test"
    person = User.create!(name:, email:, provider: "test", uid: email,
                          api_token: SecureRandom.hex(8))
    WorkspaceMembership.create!(user: person, workspace: workspace || in_a_workspace)
    person
  end

  def channel(slug: nil, name: "Meetings")
    slug ||= "chan-#{SecureRandom.hex(3)}"
    Channel.create!(slug:, name:)
  end

  def session_for(user, channel)
    AgentSession.create!(user:, channel:, agent_kind: "opencode", status: "idle")
  end

  def agent_run(user:, channel:, trigger: nil)
    session_for(user, channel).agent_runs.create!(status: "running", trigger_message: trigger)
  end
end

class ActiveSupport::TestCase
  parallelize(workers: 1)
  include Build
  include ActiveJob::TestHelper

  # Capture what the room would see, without stubbing the broadcast path away.
  def broadcasts(channel)
    captured = []
    stream = Broadcast.stream_for(channel)
    original = ActionCable.server.method(:broadcast)
    ActionCable.server.define_singleton_method(:broadcast) do |target, payload|
      captured << payload if target == stream
      original.call(target, payload)
    end
    yield
    captured
  ensure
    ActionCable.server.singleton_class.send(:remove_method, :broadcast)
  end
end

class ActiveSupport::TestCase
  include Build

  setup { in_a_workspace }
  teardown { Current.reset }
end

class ActionDispatch::IntegrationTest
  include Build
  include ActiveJob::TestHelper

  def auth(user) = { "Authorization" => "Bearer #{user.api_token}" }
end
