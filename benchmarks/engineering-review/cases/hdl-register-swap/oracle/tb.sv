module tb;
  logic clk = 1'b0;
  logic load = 1'b1;
  logic [3:0] left_in = 4'h1;
  logic [3:0] right_in = 4'h2;
  logic [3:0] left;
  logic [3:0] right;

  register_swap dut (.*);
  always #5 clk = ~clk;

  initial begin
    #6;
    load = 1'b0;
    #10;
    if (left !== 4'h2 || right !== 4'h1) $fatal(1, "registers did not swap");
    $finish;
  end
endmodule
