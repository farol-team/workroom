require "test_helper"

# The other half of the boundary. PostgreSQL keeps its half through row-level
# security; what a room knows is retrieved by meaning, and that lives somewhere
# a policy cannot reach — so it has to be kept by the store instead.
#
# Against a live instance, because a mock of an isolation boundary asserts only
# that we understood it (Article V). Set OPENVIKING_URL and two accounts' keys.
class Memory::PerWorkspaceStoreTest < ActiveSupport::TestCase
  ACME = "OPENVIKING_ACME_KEY".freeze
  GLOBEX = "OPENVIKING_GLOBEX_KEY".freeze

  setup do
    skip "set OPENVIKING_URL, #{ACME} and #{GLOBEX} to run this against a live store" \
      if ENV["OPENVIKING_URL"].blank? || ENV[ACME].blank? || ENV[GLOBEX].blank?

    @acme = workspace(name: "Acme")
    @acme.update!(openviking_url: ENV["OPENVIKING_URL"], openviking_api_key: ENV[ACME])
    @globex = workspace(name: "Globex")
    @globex.update!(openviking_url: ENV["OPENVIKING_URL"], openviking_api_key: ENV[GLOBEX])
  end

  def store_for(room)
    Memory::Selection.new(ENV, room).store
  end

  test "each workspace gets its own account, not the one the environment names" do
    assert_instance_of Memory::OpenViking, store_for(@acme)
    refute_equal store_for(@acme).instance_variable_get(:@api_key),
                 store_for(@globex).instance_variable_get(:@api_key)
  end

  test "what one room knows is not in the other, and the store is what refuses" do
    enter(@acme)
    theirs = channel(slug: "salaries-#{SecureRandom.hex(3)}", name: "Salaries")
    store_for(@acme).write(theirs, title: "Everyone gets a raise",
                                   detail: "Agreed in the meeting.", trust: "human")

    # The control: it is really there, or "Globex saw nothing" proves nothing.
    assert_equal 1, store_for(@acme).count(theirs)

    assert_equal 0, store_for(@globex).count(theirs),
                 "an account is the store's own boundary, and this is what it is for"
    assert_empty store_for(@globex).all(theirs)
  end

  test "a workspace with nothing configured gets what the environment names" do
    plain = workspace(name: "Plain")

    assert_equal ENV["OPENVIKING_URL"],
                 store_for(plain).instance_variable_get(:@base).to_s
  end
end
