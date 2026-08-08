require "test_helper"

# A turn that runs on this server.
#
# Article V: the model provider is an external HTTP API and is the only thing stubbed.
# The rail, the registry, the memory store, the run, its steps, the broadcast and the
# database boundary are all real here — a turn whose tools were fakes would prove that
# the loop calls something, which is not the question.
class Turn::RunTest < ActiveSupport::TestCase
  setup do
    @channel = channel(name: "Sales")
    @alice = user(name: "Alice")
    @channel.memberships.create!(user: @alice)
    @alice.update!(execution_mode: "hosted")
    UserCredential.create!(user: @alice, provider: "anthropic", secret: "sk-ant-notreal")
    @message = @channel.messages.create!(author: @alice, body: "What stage is the Acme deal at?")
    @run = agent_run(user: @alice, channel: @channel, trigger: @message)
  end

  teardown do
    Turn::Model.http = nil
    Rail::Bound.http = nil
  end

  test "a turn that has an answer says it in the room" do
    says("The Acme deal is in negotiation.")

    Turn::Run.new(@run).call

    said = @channel.messages.where(author: @run).last
    assert said, "the room hears from the agent, not from a log"
    assert_equal "The Acme deal is in negotiation.", said.body
    assert_equal "succeeded", @run.reload.status
  end

  # The whole capability surface, and the reason there is nothing here to sandbox: no
  # filesystem, no shell, no process. Two tools over one channel.
  test "the agent is offered the rail and nothing else" do
    offered = nil
    Turn::Model.http = lambda do |body, _credential|
      offered ||= body[:tools].map { |t| t[:name] }
      answered("Nothing to do.")
    end

    Turn::Run.new(@run).call

    assert_equal %w[search_capabilities execute_capability], offered
  end

  test "what the room knows is what the turn reads" do
    Memory::Store.current.write(@channel, title: "Acme's stage",
                                detail: "Acme signed the pilot in June.", trust: "human", author: @alice)
    came_back = nil
    Turn::Model.http = lambda do |body, _credential|
      # The second pass carries what the rail actually answered. Reading it here is
      # the difference between proving the loop calls a tool and proving the room's
      # own record reached the model.
      said = body[:messages].last[:content]
      result = said.is_a?(Array) ? said.find { |c| c[:type] == "tool_result" } : nil
      next (came_back = result[:content]; answered("Acme signed the pilot in June.")) if result

      tool_call("search_capabilities", { "query" => "Acme stage" })
    end

    Turn::Run.new(@run).call

    assert_includes came_back.to_s, "Acme's stage",
                    "what the channel knows is what came back through the rail"
    assert_equal "Acme signed the pilot in June.", @channel.messages.where(author: @run).last.body
    steps = @run.run_steps.reload
    assert steps.any? { |s| s.kind == "tool_use" }, "the process is legible, not silent"
    assert steps.any? { |s| s.kind == "tool_result" }
  end

  # #302 through the whole stack. The turn asks to do something outside the room, and
  # what it gets back is a proposal — the far end is never reached.
  test "a change outside the room is proposed by the turn, not made by it" do
    capability = BoundCapability.create!(
      workspace: Current.workspace, key: "send-quote", title: "Send the quote",
      summary: "Email the customer the quote we agreed.", endpoint: "https://crm.test/mcp",
      tool: "send_quote", credential: "a-secret", read_only: false
    )
    Rail::Bound.http = ->(*) { raise "nobody said yes" }
    asked = []
    Turn::Model.http = lambda do |_body, _credential|
      next answered("I have proposed it.") if asked.any?

      asked << true
      tool_call("execute_capability",
                { "uri" => capability.uri, "args" => { "deal" => "4821" } })
    end

    Turn::Run.new(@run).call

    assert_equal 1, @channel.decisions.pending.count
    assert_equal({ "deal" => "4821" }, @channel.decisions.pending.sole.arguments)
    assert_equal "succeeded", @run.reload.status
  end

  test "a provider that refuses ends the turn and says so, without the key in it" do
    Turn::Model.http = ->(*) { { status: 401, body: { "error" => { "message" => "invalid x-api-key" } } } }

    Turn::Run.new(@run).call

    assert_equal "failed", @run.reload.status
    said = @channel.messages.where(author: @run).last.body
    assert_includes said, "401"
    assert_not_includes said, "sk-ant-notreal"
  end

  test "a person with no key of their own is told, not silently skipped" do
    UserCredential.delete_all
    Turn::Model.http = ->(*) { raise "there is nothing to call with" }

    Turn::Run.new(@run).call

    assert_equal "failed", @run.reload.status
    assert_match(/key/i, @channel.messages.where(author: @run).last.body)
  end

  # The room is not told where the process sat. A turn is a turn.
  test "nothing in the room says which mode produced it" do
    says("Done.")

    Turn::Run.new(@run).call

    assert_not_includes MessageSerializer.call(@channel.messages.where(author: @run).last).to_json,
                        "hosted"
  end

  private

  def says(text)
    Turn::Model.http = ->(*) { answered(text) }
  end

  def answered(text)
    { status: 200,
      body: { "content" => [ { "type" => "text", "text" => text } ],
              "stop_reason" => "end_turn", "usage" => { "input_tokens" => 10, "output_tokens" => 5 } } }
  end

  def tool_call(name, args)
    { status: 200,
      body: { "content" => [ { "type" => "tool_use", "id" => "t1", "name" => name, "input" => args } ],
              "stop_reason" => "tool_use", "usage" => { "input_tokens" => 10, "output_tokens" => 5 } } }
  end
end
