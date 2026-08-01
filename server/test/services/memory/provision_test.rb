require "test_helper"

# Against a live store, because provisioning is an isolation boundary and a mock
# of one asserts only that we understood it (Article V). Set OPENVIKING_URL and
# OPENVIKING_ROOT_KEY to run it.
class Memory::ProvisionTest < ActiveSupport::TestCase
  setup do
    skip "set OPENVIKING_URL and OPENVIKING_ROOT_KEY to run this against a live store" \
      if ENV["OPENVIKING_URL"].blank? || ENV["OPENVIKING_ROOT_KEY"].blank?

    @provision = Memory::Provision.new(url: ENV["OPENVIKING_URL"],
                                       root_key: ENV["OPENVIKING_ROOT_KEY"])
  end

  test "a workspace given an account can reach its own memory and not another's" do
    acme = @provision.call(workspace(slug: "acme-#{SecureRandom.hex(3)}", name: "Acme"))
    globex = @provision.call(workspace(slug: "globex-#{SecureRandom.hex(3)}", name: "Globex"))

    enter(acme)
    room = channel(slug: "salaries-#{SecureRandom.hex(3)}", name: "Salaries")
    Memory::Selection.new(ENV, acme).store.write(
      room, title: "Everyone gets a raise", detail: "Agreed.", trust: "human")

    # The control: it is really there, or the assertion below proves nothing.
    assert_equal 1, Memory::Selection.new(ENV, acme).store.count(room)
    assert_equal 0, Memory::Selection.new(ENV, globex).store.count(room)
  end

  test "a workspace that already has one is not given another" do
    room = @provision.call(workspace(slug: "twice-#{SecureRandom.hex(3)}", name: "Twice"))

    # Re-provisioning a live room would hand it a key its old one does not
    # match, and its memory would be somewhere nobody is looking.
    assert_raises Memory::Provision::Error do
      @provision.call(room.reload)
    end
  end
end
